# Sessão 5 — Consistência, Atomicidade & Correção

**Tópicos:** Consistência de dados, escritas condicionais, contadores atômicos, transações, TTL

&nbsp;

---

&nbsp;

## Passo 1 — Consistência de dados

No DynamoDB, toda escrita é replicada em múltiplas zonas de disponibilidade. Leituras podem ser configuradas para dois modos:

&nbsp;

### Leitura eventualmente consistente (padrão)

A leitura pode retornar dados ligeiramente desatualizados — geralmente dentro de alguns milissegundos. É o modo padrão de `GetItem`, `Query` e `Scan`.

```bash
# Leitura eventualmente consistente (padrão — sem flag adicional)
aws dynamodb get-item \
  --table-name mentorship_store \
  --key '{"PK": {"S": "STORE#abc"}, "SK": {"S": "PROD#5449000000996"}}'
```

&nbsp;

### Leitura fortemente consistente

Garante que a leitura reflete a escrita mais recente. Necessário quando a aplicação precisa de **read-your-own-write** — por exemplo, logo após um `PutItem` crítico.

```bash
# Leitura fortemente consistente
aws dynamodb get-item \
  --table-name mentorship_store \
  --key '{"PK": {"S": "STORE#abc"}, "SK": {"S": "PROD#5449000000996"}}' \
  --consistent-read
```

&nbsp;

### Impacto no custo

| Modo | RCUs por leitura (item ≤ 4KB) |
|---|---|
| Eventualmente consistente | 0.5 RCU |
| Fortemente consistente | 1 RCU |

> **Regra prática:** use consistência eventual por padrão — é mais barato e suficiente para a maioria dos casos. Reserve consistência forte para operações onde ler um dado desatualizado causaria um problema real (ex: validação de saldo, controle de estoque crítico).

> **Atenção:** GSIs **não suportam** leitura fortemente consistente — apenas a tabela base e LSIs.

&nbsp;

---

&nbsp;

## Passo 2 — Escritas condicionais

Por padrão, `PutItem` e `UpdateItem` sobrescrevem qualquer item existente sem verificações. A `ConditionExpression` permite adicionar uma **pré-condição**: a escrita só ocorre se a condição for verdadeira. Se falhar, o DynamoDB lança `ConditionalCheckFailedException` — sem alterar nada.

&nbsp;

### Caso de uso 1: evitar sobrescrever um item existente

Ao criar um produto, queremos garantir que não existe outro com a mesma chave:

```bash
aws dynamodb put-item \
  --table-name mentorship_store \
  --item '{
    "PK":     {"S": "STORE#abc"},
    "SK":     {"S": "PROD#5449000000996"},
    "name":   {"S": "Coca Cola"},
    "entity": {"S": "product"}
  }' \
  --condition-expression "attribute_not_exists(PK)"
```

Se um item com `PK = STORE#abc` e `SK = PROD#5449000000996` já existir, a operação falha. Sem essa condição, o `PutItem` simplesmente substituiria o item existente.

&nbsp;

### Caso de uso 2: locking otimista com campo `version`

Estratégia para evitar que duas escritas simultâneas se sobrescrevam. Cada item tem um campo `version`; a escrita só ocorre se a versão no banco ainda for a mesma que foi lida:

```bash
# Atualiza o nome do produto APENAS se version ainda for 1
aws dynamodb update-item \
  --table-name mentorship_store \
  --key '{"PK": {"S": "STORE#abc"}, "SK": {"S": "PROD#5449000000996"}}' \
  --update-expression "SET #name = :name, version = :newVersion" \
  --condition-expression "version = :expectedVersion" \
  --expression-attribute-names '{"#name": "name"}' \
  --expression-attribute-values '{
    ":name":            {"S": "Coca Cola Zero"},
    ":newVersion":      {"N": "2"},
    ":expectedVersion": {"N": "1"}
  }'
```

Se outra requisição já tiver incrementado o `version` para `2`, essa operação falha — o cliente deve re-ler o item e tentar novamente.

&nbsp;

### Funções de condição disponíveis

| Função / operador | Descrição |
|---|---|
| `attribute_exists(path)` | Item possui o atributo |
| `attribute_not_exists(path)` | Item não possui o atributo |
| `attribute_type(path, type)` | Atributo é de um tipo específico |
| `begins_with(path, substr)` | String começa com prefixo |
| `contains(path, operand)` | String ou lista contém o valor |
| `=`, `<>`, `<`, `>`, `<=`, `>=` | Comparações numéricas ou de string |

&nbsp;

---

&nbsp;

## Passo 3 — Contadores atômicos

Um padrão comum é incrementar ou decrementar um valor numérico — por exemplo, contagem de visualizações ou estoque disponível. A abordagem ingênua de **read-modify-write** tem uma race condition: duas requisições podem ler o mesmo valor, incrementar e gravar — e uma das atualizações se perde.

```
❌ Race condition:
  Thread A lê stock = 10
  Thread B lê stock = 10
  Thread A escreve stock = 9
  Thread B escreve stock = 9   ← deveria ser 8!
```

O DynamoDB resolve isso com `ADD` no `UpdateExpression` — o incremento é **atômico no servidor**:

```bash
# Decrementa o estoque em 1, atomicamente
aws dynamodb update-item \
  --table-name mentorship_store \
  --key '{"PK": {"S": "STORE#abc"}, "SK": {"S": "PROD#5449000000996"}}' \
  --update-expression "ADD stock :delta" \
  --expression-attribute-values '{":delta": {"N": "-1"}}'

# Incrementa visualizações em 1
aws dynamodb update-item \
  --table-name mentorship_store \
  --key '{"PK": {"S": "STORE#abc"}, "SK": {"S": "PROD#5449000000996"}}' \
  --update-expression "ADD views :delta" \
  --expression-attribute-values '{":delta": {"N": "1"}}'
```

> **Atenção:** contadores atômicos não garantem que o valor nunca fique negativo. Para isso, combine `ADD` com uma `ConditionExpression`:
> ```bash
> --condition-expression "stock >= :minStock" \
> --expression-attribute-values '{":delta": {"N": "-1"}, ":minStock": {"N": "1"}}'
> ```

&nbsp;

---

&nbsp;

## Passo 4 — Transações

Transações permitem agrupar múltiplas operações em uma única chamada **all-or-nothing**: ou todas têm sucesso, ou nenhuma é aplicada.

&nbsp;

### `TransactWriteItems`

Até **100 itens** em uma única transação de escrita. Suporta `Put`, `Update`, `Delete` e `ConditionCheck` (verifica uma condição sem escrever).

**Caso de uso: transferir estoque entre stores**

Ao mover estoque da Loja A para a Loja B, precisamos que o decremento e o incremento ocorram juntos — nenhum pode acontecer sem o outro:

```bash
aws dynamodb transact-write-items \
  --transact-items '[
    {
      "Update": {
        "TableName": "mentorship_store",
        "Key": {
          "PK": {"S": "STORE#loja-a"},
          "SK": {"S": "PROD#5449000000996"}
        },
        "UpdateExpression": "ADD stock :delta",
        "ConditionExpression": "stock >= :minStock",
        "ExpressionAttributeValues": {
          ":delta":    {"N": "-5"},
          ":minStock": {"N": "5"}
        }
      }
    },
    {
      "Update": {
        "TableName": "mentorship_store",
        "Key": {
          "PK": {"S": "STORE#loja-b"},
          "SK": {"S": "PROD#5449000000996"}
        },
        "UpdateExpression": "ADD stock :delta",
        "ExpressionAttributeValues": {
          ":delta": {"N": "5"}
        }
      }
    }
  ]'
```

Se a Loja A não tiver estoque suficiente (`ConditionExpression` falha), **nenhuma** das duas escritas é aplicada.

&nbsp;

### `TransactGetItems`

Leitura consistente de múltiplos itens em uma única chamada. Os itens são lidos como um snapshot — sem risco de ler metade dos dados antes de uma transação de escrita e a outra metade depois.

```bash
aws dynamodb transact-get-items \
  --transact-items '[
    {
      "Get": {
        "TableName": "mentorship_store",
        "Key": {"PK": {"S": "STORE#loja-a"}, "SK": {"S": "PROD#5449000000996"}}
      }
    },
    {
      "Get": {
        "TableName": "mentorship_store",
        "Key": {"PK": {"S": "STORE#loja-b"}, "SK": {"S": "PROD#5449000000996"}}
      }
    }
  ]'
```

&nbsp;

### Limitações das transações

| Limite | Valor |
|---|---|
| Itens por transação | 100 |
| Tamanho total | 4 MB |
| Custo de WCU | 2× por item (vs escrita normal) |
| Custo de RCU | 2× por item (vs leitura normal) |
| Escopo | Mesma região AWS |
| GSIs | Não participam diretamente (são atualizados após a transação) |

> **Transações não são gratuitas:** cada item numa `TransactWrite` custa o dobro de WCUs comparado a um `PutItem` isolado. Use quando a atomicidade é realmente necessária.

&nbsp;

---

&nbsp;

## Passo 5 — TTL (Time to Live)

TTL permite que itens **expirem e sejam deletados automaticamente** pelo DynamoDB, sem consumir WCUs. Basta definir um atributo numérico contendo um **Unix timestamp** (segundos desde 1970-01-01T00:00:00Z) que representa a data de expiração.

&nbsp;

### Configurando o TTL na tabela

```bash
aws dynamodb update-time-to-live \
  --table-name mentorship_store \
  --time-to-live-specification "Enabled=true, AttributeName=expiresAt"
```

&nbsp;

### Inserindo um item com TTL

```bash
# Promoção válida por 24 horas (TTL = agora + 86400 segundos)
aws dynamodb put-item \
  --table-name mentorship_store \
  --item '{
    "PK":        {"S": "STORE#abc"},
    "SK":        {"S": "PROMO#5449000000996"},
    "entity":    {"S": "promotion"},
    "discount":  {"N": "15"},
    "expiresAt": {"N": "1735776000"}
  }'
```

&nbsp;

### Comportamento do TTL

- O DynamoDB verifica periodicamente os itens e deleta os expirados **dentro de ~48 horas** após o timestamp
- Itens expirados mas ainda não deletados **podem ser retornados** em queries — filtre com `FilterExpression: expiresAt > :now` se precisar de precisão
- Deleções por TTL **não consomem WCUs** e aparecem nos DynamoDB Streams como eventos `REMOVE` (útil para acionar limpezas em cascata via Lambda)

&nbsp;

### Casos de uso comuns

| Caso de uso | TTL típico |
|---|---|
| Sessões de usuário | +24h ou +7 dias |
| Tokens de reset de senha | +1h |
| Promoções temporárias | Data de fim da promoção |
| Cache de resultados de query | +5min a +1h |
| Logs de auditoria com retenção | +90 dias |

&nbsp;

### Resumo dos conceitos abordados

| Conceito | Regra prática |
|---|---|
| Consistência eventual | Padrão; 0.5 RCU; suficiente para a maioria dos casos |
| Consistência forte | 1 RCU; use quando read-your-own-write é crítico; não disponível em GSIs |
| `ConditionExpression` | Torna qualquer escrita condicional; lança `ConditionalCheckFailedException` se falhar |
| Locking otimista | Campo `version` + condição na escrita; cliente re-tenta em caso de conflito |
| Contador atômico | `ADD` no `UpdateExpression`; sem race condition; combine com condição para limite mínimo |
| `TransactWrite` | All-or-nothing; até 100 itens; 2× WCU por item |
| `TransactGet` | Snapshot consistente de múltiplos itens; 2× RCU por item |
| TTL | Expiração automática sem WCU; delay de até ~48h; filtre itens expirados nas queries |

&nbsp;

---

&nbsp;

> **Próximo passo:** executar os exemplos ao vivo em [`index.ts`](./index.ts).
