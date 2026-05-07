# Sessão 4 — Índices Secundários: LSI e GSI

**Tópicos:** LSI vs GSI — diferenças e restrições, tipos de projeção, write amplification, GSIs orientados a padrões de acesso

&nbsp;

---

&nbsp;

## Passo 1 — Os padrões de acesso que a tabela base não resolve

Na sessão anterior chegamos ao seguinte design para a `mentorship_store`:

```
mentorship_store (tabela base)

PK                             SK                    entity     name           barcode       createdAt
────────────────────────────── ───────────────────── ────────── ────────────── ───────────── ────────────────────────
STORE#store_ABC                STORE#store_ABC        store      Loja ABC       —             2024-01-01T08:00:00Z
STORE#store_XYZ                STORE#store_XYZ        store      Loja XYZ       —             2024-01-02T09:00:00Z
STORE#store_ABC                PROD#5449000000996     product    Coca Cola      5449000000996 2024-01-10T08:00:00Z
STORE#store_ABC                PROD#7622300441937     product    KitKat         7622300441937 2024-03-22T14:45:00Z
STORE#store_XYZ                PROD#5449000000996     product    Coca Cola      5449000000996 2024-02-05T11:20:00Z
```

&nbsp;

### Padrões de acesso: o que funciona e o que não funciona

| # | Padrão de acesso | Operação | Status |
|---|---|---|---|
| 1 | Buscar uma loja pelo ID | `GetItem` PK+SK | ✅ |
| 2 | Listar produtos de uma loja | `Query` PK=`STORE#<id>`, SK `begins_with PROD#` | ✅ |
| 3 | Buscar um produto específico | `GetItem` PK+SK | ✅ |
| 4 | **Listar todos os produtos de todas as lojas** | ??? | ❌ |
| 5 | **Listar produtos de uma loja ordenados por data** | ??? | ❌ |

&nbsp;

### Por que os padrões 4 e 5 falham?

**Padrão 4 — cross-partition:** Produtos de lojas diferentes vivem em partições diferentes (`STORE#store_ABC` e `STORE#store_XYZ` são PKs distintas). O `Query` só acessa uma partição por vez. A única saída sem índice é o `Scan` — que percorre a tabela inteira.

**Padrão 5 — SK errada:** A SK dos produtos é `PROD#<barcode>`, então os itens de uma loja são ordenados por barcode. Não há como obter ordenação por data sem alterar a SK — o que quebraria o padrão 2.

> **Regra:** cada padrão de acesso que cruza partições ou exige ordenação diferente da SK base precisa de um índice secundário.

&nbsp;

---

&nbsp;

## Passo 2 — LSI vs GSI: diferenças fundamentais

Existem dois tipos de índices secundários no DynamoDB, com características muito diferentes:

&nbsp;

### LSI — Local Secondary Index

- **Mesma PK** da tabela base, **SK diferente**
- Permite ordenação alternativa dentro da mesma partição
- **Deve ser definido na criação da tabela** — não pode ser adicionado depois
- Leituras com **consistência forte** disponíveis (os dados estão na mesma partição)
- Limite: máximo **5 LSIs** por tabela
- Limite: todos os itens de uma mesma PK (tabela base + todos os LSIs) não podem ultrapassar **10 GB**

&nbsp;

### GSI — Global Secondary Index

- **PK e SK completamente independentes** da tabela base — qualquer atributo pode ser a chave
- Acessa itens de **múltiplas partições** (por isso "Global")
- **Pode ser adicionado ou removido a qualquer momento** em uma tabela existente
- Leituras com **consistência eventual** apenas
- Limite: máximo **20 GSIs** por tabela
- Sem limite de tamanho de partição

&nbsp;

### Tabela comparativa

| Critério | LSI | GSI |
|---|---|---|
| PK | Mesma da tabela base | Qualquer atributo |
| SK | Diferente da tabela base | Qualquer atributo |
| Quando criar | Somente na criação da tabela | A qualquer momento |
| Consistência de leitura | Forte ou eventual | Eventual apenas |
| Limite de partição | 10 GB por PK | Sem limite |
| Máximo por tabela | 5 | 20 |
| Quando usar | Ordenação alternativa na mesma PK, consistência forte necessária | Padrões cross-partition, flexibilidade de criação tardia |

&nbsp;

### O caso da `mentorship_store`

O GSI `store-products-by-date` que criaremos no Passo 5 usa exatamente a mesma PK da tabela base (`PK = STORE#<id>`). Isso seria um candidato natural para um **LSI** — mas a `mentorship_store` foi criada na sessão 3 sem LSIs, e não há como adicioná-los retroativamente. Esse é um trade-off real: se souber desde o início que vai precisar de ordenação alternativa dentro de uma partição, defina o LSI na criação da tabela.

&nbsp;

---

&nbsp;

## Passo 3 — Tipos de projeção e impacto de custo

Ao criar um índice secundário, é preciso definir quais atributos serão **copiados** (projetados) da tabela base para o índice. Essa escolha tem impacto direto em custo de storage e em quantas chamadas ao DynamoDB são necessárias por query.

&nbsp;

### KEYS_ONLY

Apenas as chaves da tabela base (PK, SK) e as chaves do índice são projetadas. Qualquer outro atributo exige um `GetItem` separado na tabela base após a query no índice.

- ✅ Menor custo de storage
- ✅ Menor custo de write amplification (só keys são copiadas)
- ❌ Geralmente exige um segundo round-trip para buscar os atributos completos

&nbsp;

### INCLUDE

Uma lista explícita de atributos adicionais é projetada junto com as chaves. Você escolhe exatamente quais campos a query no índice vai precisar.

- ✅ Custo de storage médio e controlado
- ✅ Evita double-fetch quando os campos projetados são suficientes
- ❌ Qualquer campo não listado ainda exige um `GetItem` separado

&nbsp;

### ALL

Todos os atributos da tabela base são copiados para o índice. A query retorna o item completo.

- ✅ Nenhum double-fetch necessário
- ❌ Maior custo de storage
- ❌ Maior custo de write amplification — qualquer escrita na tabela base que altere um atributo projetado dispara uma escrita no índice

&nbsp;

### Tabela de trade-offs

| Tipo | Storage | Double-fetch | Write amplification | Quando usar |
|---|---|---|---|---|
| `KEYS_ONLY` | Mínimo | Quase sempre | Mínima | Índice de lookup puro; atributos buscados separadamente |
| `INCLUDE` | Médio | Às vezes | Média | Subset de campos bem conhecido e estável |
| `ALL` | Máximo | Nunca | Máxima | Queries que precisam de todos os campos; simplicidade |

> **Nota sobre write amplification:** independente do tipo de projeção, toda escrita na tabela base que altera uma **chave do índice** (PK ou SK do GSI) gera uma escrita no índice. Com `ALL`, alterar qualquer atributo projetado também conta.

&nbsp;

---

&nbsp;

## Passo 4 — GSI caso de uso 1: listar itens por tipo de entidade

**Padrão não atendido:** "listar todos os produtos de todas as lojas" (padrão 4)

A solução é um GSI que usa o campo `entity` como PK. Como `entity` existe em todos os itens (`"store"` ou `"product"`), esse GSI agrupa os itens por tipo — independente de qual partição base eles estão.

&nbsp;

### Definição do índice

```
GSI: entity-index

GSI PK:    entity   (S)  →  "store" | "product"
GSI SK:    SK       (S)  →  valor da SK da tabela base
Projeção:  ALL
```

&nbsp;

### Como o índice enxerga os dados

```
entity-index (GSI)

entity (GSI PK)   SK (GSI SK)            PK (base)         name
───────────────   ──────────────────     ──────────────    ──────────
product           PROD#5449000000996     STORE#store_ABC   Coca Cola
product           PROD#5449000000996     STORE#store_XYZ   Coca Cola
product           PROD#7622300441937     STORE#store_ABC   KitKat
store             STORE#store_ABC        STORE#store_ABC   Loja ABC
store             STORE#store_XYZ        STORE#store_XYZ   Loja XYZ
```

Todos os produtos estão agrupados sob `entity = "product"` — independente da store. Um único `Query` retorna todos eles.

&nbsp;

### Criando o GSI com o AWS CLI

```bash
aws dynamodb update-table \
  --table-name mentorship_store \
  --attribute-definitions \
    AttributeName=entity,AttributeType=S \
    AttributeName=SK,AttributeType=S \
  --global-secondary-index-updates '[{
    "Create": {
      "IndexName": "entity-index",
      "KeySchema": [
        {"AttributeName": "entity", "KeyType": "HASH"},
        {"AttributeName": "SK",     "KeyType": "RANGE"}
      ],
      "Projection": {"ProjectionType": "ALL"}
    }
  }]' \
  --billing-mode PAY_PER_REQUEST
```

&nbsp;

### Consultando o índice

```bash
# Todos os produtos (cross-partition)
aws dynamodb query \
  --table-name mentorship_store \
  --index-name entity-index \
  --key-condition-expression "entity = :e" \
  --expression-attribute-values '{":e": {"S": "product"}}'

# Todas as lojas
aws dynamodb query \
  --table-name mentorship_store \
  --index-name entity-index \
  --key-condition-expression "entity = :e" \
  --expression-attribute-values '{":e": {"S": "store"}}'
```

&nbsp;

### Sparse index: itens sem o atributo são excluídos automaticamente

Se um futuro tipo de entidade (ex: `ATTR#color`) não tiver o campo `entity` definido, ele simplesmente **não aparece** no GSI — sem custo de storage adicional e sem interferência nas queries. Isso é chamado de **sparse index** e é um padrão muito útil para indexar apenas um subconjunto dos itens da tabela.

&nbsp;

---

&nbsp;

## Passo 5 — GSI caso de uso 2: produtos ordenados por data de criação

**Padrão não atendido:** "listar produtos de uma loja ordenados por data de criação" (padrão 5)

A solução é um GSI que reutiliza a PK da tabela base (`PK = STORE#<id>`) mas usa `createdAt` como SK. Com isso, os produtos de uma loja ficam ordenados cronologicamente dentro do índice.

&nbsp;

### Definição do índice

```
GSI: store-products-by-date

GSI PK:    PK          (S)  →  "STORE#<id>" (mesmo valor da PK base)
GSI SK:    createdAt   (S)  →  ISO 8601, ex: "2024-01-10T08:00:00Z"
Projeção:  ALL
```

> **ISO 8601 ordena corretamente como string:** `"2024-01-10..."` vem antes de `"2024-03-22..."` tanto numericamente quanto lexicograficamente — isso torna strings ISO 8601 UTC ideais como SK de ordenação temporal no DynamoDB.

&nbsp;

### Como o índice enxerga os dados

```
store-products-by-date (GSI)

PK (GSI PK)         createdAt (GSI SK)         SK (base)              name
──────────────────  ─────────────────────────  ─────────────────────  ──────────
STORE#store_ABC     2024-01-10T08:00:00Z        PROD#5449000000996     Coca Cola
STORE#store_ABC     2024-03-22T14:45:00Z        PROD#7622300441937     KitKat
STORE#store_XYZ     2024-02-05T11:20:00Z        PROD#5449000000996     Coca Cola
```

Itens de `entity = "store"` não têm `createdAt` — eles **não aparecem neste GSI** (sparse index automático).

&nbsp;

### Relação com LSI

Este GSI tem exatamente a mesma PK da tabela base. Na teoria, seria um candidato perfeito para um **LSI** — que ofereceria leituras com consistência forte e sem os custos de write amplification de um GSI separado. Porém, como a `mentorship_store` foi criada na sessão 3 sem LSIs, não é possível adicioná-los agora. Essa limitação real demonstra por que é importante **mapear os padrões de acesso antes de criar a tabela**.

&nbsp;

### Criando o GSI com o AWS CLI

```bash
aws dynamodb update-table \
  --table-name mentorship_store \
  --attribute-definitions \
    AttributeName=PK,AttributeType=S \
    AttributeName=createdAt,AttributeType=S \
  --global-secondary-index-updates '[{
    "Create": {
      "IndexName": "store-products-by-date",
      "KeySchema": [
        {"AttributeName": "PK",        "KeyType": "HASH"},
        {"AttributeName": "createdAt", "KeyType": "RANGE"}
      ],
      "Projection": {"ProjectionType": "ALL"}
    }
  }]' \
  --billing-mode PAY_PER_REQUEST
```

&nbsp;

### Consultando o índice

```bash
# Produtos de uma loja do mais recente para o mais antigo
aws dynamodb query \
  --table-name mentorship_store \
  --index-name store-products-by-date \
  --key-condition-expression "PK = :pk" \
  --expression-attribute-values '{":pk": {"S": "STORE#store_ABC"}}' \
  --scan-index-forward false

# Produtos criados após uma data específica
aws dynamodb query \
  --table-name mentorship_store \
  --index-name store-products-by-date \
  --key-condition-expression "PK = :pk AND createdAt >= :since" \
  --expression-attribute-values '{
    ":pk":    {"S": "STORE#store_ABC"},
    ":since": {"S": "2024-02-01T00:00:00Z"}
  }' \
  --scan-index-forward false
```

&nbsp;

---

&nbsp;

## Passo 6 — Write amplification e resumo de custos

Com dois GSIs ativos, cada escrita na tabela base pode gerar escritas adicionais nos índices.

&nbsp;

### Exemplo concreto: criar um produto

Um único `PutItem` em um produto novo (item < 1 KB) resulta em:

| Destino | WCUs consumidas | Motivo |
|---|---|---|
| Tabela base | 1 | Item escrito diretamente |
| `entity-index` | 1 | Campo `entity` está presente → item indexado |
| `store-products-by-date` | 1 | Campo `createdAt` está presente → item indexado |
| **Total** | **3** | |

&nbsp;

### Projeção `ALL` vs `KEYS_ONLY`: impacto em updates

| Operação | Projeção do GSI | WCUs extras no GSI | Motivo |
|---|---|---|---|
| `UpdateItem` altera `name` | `ALL` | 1 por GSI | `name` está projetado → write no índice |
| `UpdateItem` altera `name` | `KEYS_ONLY` | 0 | `name` não é chave → sem write no índice |
| `UpdateItem` altera `createdAt` | Qualquer | 1 | `createdAt` é SK do GSI → write obrigatório |

&nbsp;

### Sparse index: economia proporcional à esparsidade

Se apenas 10% dos itens da tabela têm o campo `createdAt`, o GSI `store-products-by-date` armazena apenas esses 10% — reduzindo storage e eliminando write amplification nos outros 90% das escritas.

&nbsp;

### Resumo dos conceitos abordados

| Conceito | Regra prática |
|---|---|
| LSI | Mesma PK, SK diferente; definido na criação da tabela; consistência forte disponível |
| GSI | PK e SK livres; adicionável a qualquer momento; consistência eventual |
| `KEYS_ONLY` | Mínimo storage, geralmente exige double-fetch |
| `INCLUDE` | Storage controlado para um subset conhecido de campos |
| `ALL` | Máximo storage, sem double-fetch |
| Write amplification | 1 `PutItem` = 1 + N escritas (N = GSIs/LSIs que indexam o item) |
| Sparse index | Itens sem o atributo indexado não entram no índice — economia automática |
| ISO 8601 como SK | Ordena lexicograficamente = cronologicamente para datas UTC |

&nbsp;

---

&nbsp;

> **Próximo passo:** executar as queries ao vivo em [`index.ts`](./index.ts).
