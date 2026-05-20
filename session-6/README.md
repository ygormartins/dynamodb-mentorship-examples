# Sessão 6 — Scaling & Hot Partitions

**Tópicos:** Hot keys e hot partitions, RCU e WCU em detalhe, on-demand vs provisioned, monitoramento

&nbsp;

---

&nbsp;

## Passo 1 — Hot Keys e Hot Partitions

O DynamoDB distribui os dados entre partições físicas com base na partition key. Cada partição tem um limite de throughput:

- **3.000 RCUs/s** por partição
- **1.000 WCUs/s** por partição

Quando muitas requisições chegam para a **mesma PK ao mesmo tempo**, a partição correspondente atinge esse limite e começa a **throttlear** as requisições extras — retornando `ProvisionedThroughputExceededException`. Isso é chamado de **hot partition**.

&nbsp;

### O cenário: atributos de produto com PK = storeId

No design atual da `mentorship_store` (das sessões anteriores), todos os itens de uma loja compartilham a mesma partition key: `STORE#<storeId>`. Isso inclui os atributos dos produtos:

```
mentorship_store (design atual)

PK                      SK                         entity             value
─────────────────────── ────────────────────────── ────────────────── ──────────
STORE#store_ABC         STORE#store_ABC             store              —
STORE#store_ABC         PROD#5449000000996          product            —
STORE#store_ABC         PROD#7622300441937          product            —
STORE#store_ABC         ATTR#5449000000996#color    product_attribute  Vermelho   ← mesma PK
STORE#store_ABC         ATTR#5449000000996#size     product_attribute  350ml      ← mesma PK
STORE#store_ABC         ATTR#7622300441937#color    product_attribute  Marrom     ← mesma PK
```

Enquanto o tráfego é baixo, isso funciona. O problema surge quando a **loja é popular**: todos os usuários navegando no catálogo da Loja ABC — lendo atributos de qualquer produto — chegam na mesma partição:

```
Usuário 1  → Query PK=STORE#store_ABC (Coca Cola)   ─┐
Usuário 2  → Query PK=STORE#store_ABC (KitKat)      ─┤→  PARTIÇÃO STORE#store_ABC  ← 🔥 sobrecarga
Usuário 3  → Query PK=STORE#store_ABC (Nescafé)     ─┤
Usuário 4  → Query PK=STORE#store_ABC (Coca Cola)   ─┘
```

Com tráfego suficiente, essa única partição ultrapassa 3.000 RCUs/s e começa a retornar erros — independente de quantas outras partições da tabela estejam completamente ociosas.

&nbsp;

### A solução: PK composta por `storeId` + barcode

Ao incluir o barcode do produto na partition key dos atributos, cada produto passa a ter sua própria partição — distribuindo o tráfego da loja entre múltiplas partições:

```
mentorship_store (design melhorado para atributos)

PK                                    SK              entity             value
───────────────────────────────────── ─────────────── ────────────────── ──────────
STORE#store_ABC                       STORE#store_ABC  store              —
STORE#store_ABC                       PROD#5449000000996  product         —
STORE#store_ABC#PROD#5449000000996    ATTR#color      product_attribute  Vermelho
STORE#store_ABC#PROD#5449000000996    ATTR#size       product_attribute  350ml
STORE#store_ABC#PROD#7622300441937    ATTR#color      product_attribute  Marrom
```

Agora as mesmas requisições são distribuídas por produto:

```
Usuário 1  → Query PK=STORE#store_ABC#PROD#5449000000996  →  PARTIÇÃO Coca Cola da Loja ABC
Usuário 2  → Query PK=STORE#store_ABC#PROD#7622300441937  →  PARTIÇÃO KitKat da Loja ABC
Usuário 3  → Query PK=STORE#store_ABC#PROD#7613036809213  →  PARTIÇÃO Nescafé da Loja ABC
Usuário 4  → Query PK=STORE#store_ABC#PROD#5449000000996  →  PARTIÇÃO Coca Cola da Loja ABC
```

O storeId ainda está presente na PK — mantendo a hierarquia — mas o barcode garante que produtos diferentes não competem pela mesma partição.

&nbsp;

### Quando o storeId não resolve: write sharding

Se o problema for uma **única entidade com altíssimo volume de leituras** (ex: um item de configuração global lido por toda a aplicação), adicionar o storeId não ajuda. Nesse caso, a técnica é o **write sharding**: criar múltiplas cópias do item com sufixos numéricos aleatórios na PK e distribuir as leituras entre elas:

```
PK = "CONFIG#GLOBAL#0"   ← shard 0
PK = "CONFIG#GLOBAL#1"   ← shard 1
PK = "CONFIG#GLOBAL#2"   ← shard 2
...
PK = "CONFIG#GLOBAL#N"   ← shard N
```

Na leitura, o cliente escolhe um shard aleatório: `shard = Math.floor(Math.random() * N)`. As escritas atualizam todos os shards (ou usam um fan-out via Lambda/Stream). Isso multiplica o throughput disponível por N, ao custo de N vezes mais storage e writes.

&nbsp;

### Resumo das estratégias anti-hot-key

| Estratégia | Quando usar |
|---|---|
| Compor PK com dimensão de tenant (ex: storeId) | Multi-tenant: cada tenant tem tráfego independente |
| Write sharding com sufixo aleatório | Item único com altíssima leitura global |
| Cache (DAX ou externo) | Reads repetidas do mesmo item; alivia DynamoDB completamente |
| Revisar o modelo de dados | Às vezes o hot key indica um problema de design — rever padrões de acesso |

&nbsp;

---

&nbsp;

## Passo 2 — RCU e WCU em detalhe

Entender como RCUs e WCUs são calculados é essencial para estimar custo e diagnosticar throttling.

&nbsp;

### WCU — Write Capacity Unit

**1 WCU = 1 escrita de até 1 KB**

Se o item for maior que 1 KB, o custo sobe proporcionalmente (arredondado para cima):

| Tamanho do item | WCUs consumidas |
|---|---|
| 0.3 KB | 1 WCU |
| 1 KB | 1 WCU |
| 1.1 KB | 2 WCUs |
| 3.5 KB | 4 WCUs |

Operações transacionais (`TransactWrite`) custam **2× WCUs** por item.

&nbsp;

### RCU — Read Capacity Unit

**1 RCU = 1 leitura fortemente consistente de até 4 KB**

| Modo | Tamanho do item | RCUs consumidas |
|---|---|---|
| Forte | ≤ 4 KB | 1 RCU |
| Forte | 4.1 KB | 2 RCUs |
| Eventual | ≤ 4 KB | 0.5 RCU |
| Eventual | 4.1 KB | 1 RCU |
| Transacional | ≤ 4 KB | 2 RCUs |

`Query` e `Scan` consomem RCUs baseados no **total de bytes lidos** antes de qualquer `FilterExpression` — o filtro não reduz o custo de leitura, apenas os dados retornados.

&nbsp;

### Write amplification com GSIs (revisão da Sessão 4)

Toda escrita que altera uma chave de GSI ou um atributo projetado (`ALL`) gera uma escrita adicional no índice. Com 2 GSIs:

```
PutItem (produto, 0.5 KB)
  → 1 WCU na tabela base
  → 1 WCU no entity-index        (ALL projection)
  → 1 WCU no store-products-by-date  (ALL projection)
  = 3 WCUs totais
```

&nbsp;

### BatchGetItem

Agrupa até **100 GetItems** em uma única chamada de rede, sem desconto de RCU — cada item é cobrado normalmente. O benefício é a redução de latência de rede (1 round-trip em vez de N):

```bash
aws dynamodb batch-get-item \
  --request-items '{
    "mentorship_store": {
      "Keys": [
        {"PK": {"S": "STORE#abc"}, "SK": {"S": "PROD#5449000000996"}},
        {"PK": {"S": "STORE#abc"}, "SK": {"S": "PROD#7622300441937"}}
      ]
    }
  }'
```

> Itens não encontrados simplesmente não aparecem no resultado — sem erro. Itens que não couberam na resposta (limite de 16 MB) aparecem em `UnprocessedKeys` e devem ser re-requisitados.

&nbsp;

---

&nbsp;

## Passo 3 — On-Demand vs Provisioned

DynamoDB oferece dois modos de capacidade, cada um com trade-offs de custo e comportamento sob carga.

&nbsp;

### On-Demand

Você não define capacidade — o DynamoDB escala automaticamente para qualquer volume de tráfego.

- ✅ Zero configuração — não há risco de throttling por subestimar capacidade
- ✅ Ideal para tráfego imprevisível, spikes, workloads novos
- ✅ Paga exatamente pelo que usa (por RCU/WCU consumido)
- ❌ Mais caro por unidade (~2.5× mais que provisioned)
- ❌ Escala mais lentamente em doubles de tráfego (pode throttlear em spikes muito abruptos)

```bash
aws dynamodb create-table \
  --table-name mentorship_store \
  --billing-mode PAY_PER_REQUEST \
  ...
```

&nbsp;

### Provisioned

Você define antecipadamente quantas RCUs e WCUs a tabela terá por segundo.

- ✅ Mais barato para cargas previsíveis e estáveis
- ✅ Custo máximo conhecido e controlável
- ✅ Suporta **Reserved Capacity** — desconto de até 77% com compromisso de 1 ou 3 anos
- ❌ Requer planejamento de capacidade — subestimar causa throttling
- ❌ Capacidade ociosa é cobrada mesmo sem uso

```bash
aws dynamodb create-table \
  --table-name mentorship_store \
  --billing-mode PROVISIONED \
  --provisioned-throughput ReadCapacityUnits=10,WriteCapacityUnits=5 \
  ...
```

&nbsp;

### Auto Scaling (Provisioned + automação)

Provisioned pode ser combinado com **DynamoDB Auto Scaling**: a tabela ajusta RCUs/WCUs automaticamente com base em métricas do CloudWatch, dentro de limites que você define:

```bash
# Define política de auto scaling para leitura: min=5, max=100, target=70%
aws application-autoscaling register-scalable-target \
  --service-namespace dynamodb \
  --resource-id "table/mentorship_store" \
  --scalable-dimension "dynamodb:table:ReadCapacityUnits" \
  --min-capacity 5 \
  --max-capacity 100
```

> Auto Scaling **não é instantâneo** — pode levar alguns minutos para reagir a spikes. Para picos abruptos e curtos, On-Demand é mais seguro.

&nbsp;

### Burst Capacity

No modo Provisioned, o DynamoDB reserva automaticamente até **5 minutos (300 segundos)** de capacidade não utilizada como buffer de burst. Se a tabela estiver abaixo do limite por um tempo, ela pode absorver um spike temporário acima do provisionado — mas esse buffer se esgota e não é garantido.

&nbsp;

### Tabela comparativa

| Critério | On-Demand | Provisioned |
|---|---|---|
| Configuração | Nenhuma | RCUs e WCUs manuais (ou auto scaling) |
| Custo por unidade | ~2.5× mais caro | Mais barato |
| Tráfego imprevisível | ✅ Ideal | ❌ Risco de throttling |
| Tráfego estável | ❌ Caro | ✅ Ideal |
| Reserved Capacity | ❌ Não disponível | ✅ Até 77% de desconto |
| Burst instantâneo | ✅ Sim | ⚠️ Limitado ao burst buffer |
| Quando usar | Desenvolvimento, novos produtos, spikes imprevisíveis | Produção com tráfego previsível e alto volume |

&nbsp;

---

&nbsp;

## Passo 4 — Monitoramento

O DynamoDB publica métricas automáticas no **CloudWatch**. Saber quais acompanhar é essencial para detectar problemas antes que virem incidentes.

&nbsp;

### Métricas mais importantes

| Métrica | O que indica | Alarme recomendado |
|---|---|---|
| `ThrottledRequests` | Requisições rejeitadas por excesso de tráfego | Qualquer valor > 0 sustentado |
| `ConsumedReadCapacityUnits` | RCUs consumidos por segundo | > 80% do provisionado |
| `ConsumedWriteCapacityUnits` | WCUs consumidos por segundo | > 80% do provisionado |
| `SuccessfulRequestLatency` | Latência p50/p99 das operações | p99 > 50ms (investigar) |
| `SystemErrors` | Erros internos do DynamoDB (5xx) | Qualquer valor > 0 |
| `UserErrors` | Erros de requisição inválida (4xx) | Qualquer valor > 0 |
| `ConditionalCheckFailedRequests` | `ConditionExpression` falhou | Volume anormalmente alto |

&nbsp;

### Identificando hot keys com Contributor Insights

O **DynamoDB Contributor Insights** analisa os logs de acesso e identifica automaticamente as partition keys mais acessadas — exatamente o que você precisa para diagnosticar hot partitions:

```bash
# Habilitar Contributor Insights na tabela
aws dynamodb update-contributor-insights \
  --table-name mentorship_store \
  --contributor-insights-action ENABLE
```

Após habilitado, o CloudWatch exibe os rankings de:
- **Top partition keys mais lidas** (RCUs por PK)
- **Top partition keys mais escritas** (WCUs por PK)
- **Top keys com throttling** (quais PKs estão sendo throttleadas)

> Contributor Insights tem custo adicional por evento analisado. Habilite em produção durante investigações e desabilite depois se o custo for relevante.

&nbsp;

### Exemplos de alarmes no CloudWatch

```bash
# Alarme: throttling detectado
aws cloudwatch put-metric-alarm \
  --alarm-name "DynamoDB-Throttling" \
  --metric-name ThrottledRequests \
  --namespace AWS/DynamoDB \
  --dimensions Name=TableName,Value=mentorship_store \
  --statistic Sum \
  --period 60 \
  --threshold 10 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 1 \
  --alarm-actions <sns-topic-arn>

# Alarme: latência p99 acima de 50ms
aws cloudwatch put-metric-alarm \
  --alarm-name "DynamoDB-HighLatency" \
  --metric-name SuccessfulRequestLatency \
  --namespace AWS/DynamoDB \
  --dimensions Name=TableName,Value=mentorship_store Name=Operation,Value=Query \
  --extended-statistic p99 \
  --period 60 \
  --threshold 50 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 3 \
  --alarm-actions <sns-topic-arn>
```

&nbsp;

### Checklist de saúde para produção

- [ ] `ThrottledRequests = 0` em condições normais de operação
- [ ] `ConsumedCapacity < 70%` do provisionado (margem para spikes)
- [ ] `SuccessfulRequestLatency` p99 < 10ms para `GetItem`, < 20ms para `Query`
- [ ] Contributor Insights habilitado ao investigar performance
- [ ] Alarmes de throttling com notificação imediata (SNS → PagerDuty/Slack)
- [ ] Revisão periódica do uso por operação para identificar padrões de acesso inesperados

&nbsp;

### Resumo dos conceitos abordados

| Conceito | Regra prática |
|---|---|
| Hot partition | Uma PK muito acessada esgota 3k RCUs/s ou 1k WCUs/s da partição |
| Solução: PK composta | Incluir dimensão de tenant (storeId) distribui tráfego naturalmente |
| Write sharding | Para itens globais muito lidos: N cópias com sufixo `#shard` |
| WCU | 1 WCU por KB escrito (arredonda pra cima); 2× em transações |
| RCU | 1 RCU por 4 KB (forte); 0.5 RCU (eventual); 2× em transações |
| On-Demand | Escala automática; paga por uso; ideal para tráfego imprevisível |
| Provisioned | Mais barato; requer planejamento; suporta auto scaling e reserved capacity |
| Burst Capacity | Buffer de até 300s de capacidade não utilizada; não garantido |
| `ThrottledRequests` | Métrica mais importante — deve ser zero em operação normal |
| Contributor Insights | Identifica hot keys automaticamente via CloudWatch |

&nbsp;

---

&nbsp;

> **Próximo passo:** executar os exemplos ao vivo em [`index.ts`](./index.ts).
