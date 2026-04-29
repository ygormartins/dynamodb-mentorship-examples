# Sessão 3 — Modelagem Avançada de Dados

**Tópicos:** Design orientado a padrões de acesso, relacionamentos um-para-muitos e muitos-para-muitos, single-table design

&nbsp;

---

&nbsp;

## Passo 1 — Design Orientado a Padrões de Acesso

No mundo relacional, o schema vem primeiro: modelamos as entidades, definimos as chaves estrangeiras e adicionamos índices depois, conforme as queries surgem. O DynamoDB inverte essa lógica.

> **No DynamoDB, você modela os dados em função de como vai consultá-los — não o contrário.**

Antes de criar qualquer tabela, a primeira pergunta é: **quais são os padrões de acesso da aplicação?**

&nbsp;

### Os padrões de acesso do nosso sistema

| # | Padrão de acesso | Operação DynamoDB |
|---|---|---|
| 1 | Buscar uma loja pelo ID | `GetItem` |
| 2 | Listar todos os produtos de uma loja | `Query` por PK |
| 3 | Buscar um produto específico de uma loja | `GetItem` por PK + SK |
| 4 | Listar todos os atributos de um produto | `Query` por PK |
| 5 | Buscar um atributo específico de um produto | `GetItem` por PK + SK |

&nbsp;

### Por que `store_id` é a PK da tabela de produtos?

Na sessão anterior chegamos ao design `PK=store_id, SK=product_id` para a tabela de produtos. Esse design não é acidental — ele foi **ditado diretamente pelo padrão de acesso #2**: "listar todos os produtos de uma loja".

No DynamoDB, só é possível fazer `Query` eficiente quando filtramos pela **partition key exata**. Ao colocar `store_id` como PK, todos os produtos de uma loja ficam na mesma partição, prontos para serem listados com uma única operação `Query`.

```
products_v2

PK (store_id)   SK (product_id)       name         barcode
─────────────── ──────────────────    ──────────── ─────────────
store_ABC        5449000000996   Coca Cola    5449000000996
store_ABC        7622300441937   KitKat       7622300441937
store_XYZ        5449000000996   Coca Cola    5449000000996  ← mesmo barcode, loja diferente
```

Se tivéssemos usado `product_id` (UUID ou barcode) como PK isolado, o padrão #2 só seria possível com `Scan` — percorrendo a tabela inteira.

&nbsp;

### A regra de ouro

> **Cada padrão de acesso precisa de uma chave.** Se um novo padrão aparecer que não se encaixa nas chaves existentes, você provavelmente precisará de um índice secundário (GSI/LSI) — tema de uma sessão futura.

&nbsp;

---

&nbsp;

## Passo 2 — Relacionamento Um-para-Muitos

O relacionamento um-para-muitos mais comum no nosso modelo é o de **produto → atributos**: um produto pode ter muitos atributos (cor, tamanho, peso, material, etc.).

No SQL, isso é resolvido com uma tabela separada e uma chave estrangeira. No DynamoDB, resolvemos isso com **PK + SK na mesma tabela**.

&nbsp;

### Design da tabela de atributos

```
product_attributes

PK (product_id)             SK (attribute_key)   value
─────────────────────────── ──────────────────── ────────────
store_ABC#5449000000996      color           Vermelho
store_ABC#5449000000996      size            350ml
store_ABC#5449000000996      weight          0.37kg
store_XYZ#7622300441937      color           Marrom
store_XYZ#7622300441937      flavor          Chocolate
```

```bash
aws dynamodb create-table \
  --table-name product_attributes \
  --attribute-definitions \
    AttributeName=product_id,AttributeType=S \
    AttributeName=attribute_key,AttributeType=S \
  --key-schema \
    AttributeName=product_id,KeyType=HASH \
    AttributeName=attribute_key,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

&nbsp;

### Padrões de acesso suportados

```bash
# Padrão 4 — todos os atributos de um produto
aws dynamodb query \
  --table-name product_attributes \
  --key-condition-expression "product_id = :pid" \
  --expression-attribute-values '{":pid": {"S": "store_ABC#5449000000996"}}'

# Padrão 5 — um atributo específico
aws dynamodb get-item \
  --table-name product_attributes \
  --key '{
    "product_id":    {"S": "store_ABC#5449000000996"},
    "attribute_key": {"S": "color"}
  }'
```

&nbsp;

### O que temos até agora

```mermaid
erDiagram
    products_v2 {
        STRING store_id PK
        STRING product_id SK
        VARCHAR name
        VARCHAR barcode
    }
    product_attributes {
        STRING product_id PK
        STRING attribute_key SK
        TEXT value
    }

    products_v2 ||--o{ product_attributes : "possui"
```

&nbsp;

---

&nbsp;

## Passo 3 — Relacionamento Muitos-para-Muitos

Até agora, os atributos são definidos livremente por cada produto. Mas e se a plataforma quiser oferecer um **catálogo global de atributos** — com nomes, tipos e validações padronizadas — que lojas e produtos possam reutilizar?

Isso cria um relacionamento **muitos-para-muitos**: um produto pode referenciar muitos atributos globais, e um atributo global pode ser usado por muitos produtos.

&nbsp;

### Modelando o catálogo global

```
global_attributes

PK (attribute_id)    name      type     allowed_values
──────────────────── ───────── ──────── ──────────────────────────
attr#color           Cor       STRING   Vermelho, Azul, Verde, ...
attr#size            Tamanho   STRING   P, M, G, GG
attr#weight          Peso      NUMBER   —
attr#flavor          Sabor     STRING   Chocolate, Baunilha, ...
```

```bash
aws dynamodb create-table \
  --table-name global_attributes \
  --attribute-definitions \
    AttributeName=attribute_id,AttributeType=S \
  --key-schema \
    AttributeName=attribute_id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

&nbsp;

### A tabela de junção: `product_attribute_values`

Para associar um produto a um atributo global e armazenar o valor específico desse produto, precisamos de uma **tabela de junção**:

```
product_attribute_values

PK (product_id)              SK (attribute_id)   value
──────────────────────────── ─────────────────── ──────────
store_ABC#5449000000996       attr#color          Vermelho
store_ABC#5449000000996       attr#size           350ml
store_XYZ#7622300441937       attr#color          Marrom
store_XYZ#7622300441937       attr#flavor         Chocolate
```

```bash
aws dynamodb create-table \
  --table-name product_attribute_values \
  --attribute-definitions \
    AttributeName=product_id,AttributeType=S \
    AttributeName=attribute_id,AttributeType=S \
  --key-schema \
    AttributeName=product_id,KeyType=HASH \
    AttributeName=attribute_id,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

&nbsp;

### Diagrama atualizado

```mermaid
erDiagram
    products_v2 {
        STRING store_id PK
        STRING product_id SK
        VARCHAR name
        VARCHAR barcode
    }
    global_attributes {
        STRING attribute_id PK
        VARCHAR name
        VARCHAR type
        TEXT allowed_values
    }
    product_attribute_values {
        STRING product_id PK
        STRING attribute_id SK
        TEXT value
    }

    products_v2 ||--o{ product_attribute_values : "possui valores de"
    global_attributes ||--o{ product_attribute_values : "é referenciado por"
```

&nbsp;

### Padrões de acesso suportados

```bash
# Todos os atributos (com valor) de um produto
aws dynamodb query \
  --table-name product_attribute_values \
  --key-condition-expression "product_id = :pid" \
  --expression-attribute-values '{":pid": {"S": "store_ABC#5449000000996"}}'

# Valor de um atributo específico de um produto
aws dynamodb get-item \
  --table-name product_attribute_values \
  --key '{
    "product_id":   {"S": "store_ABC#5449000000996"},
    "attribute_id": {"S": "color"}
  }'

# Definição de um atributo global
aws dynamodb get-item \
  --table-name global_attributes \
  --key '{"attribute_id": {"S": "attr#color"}}'
```

> **Atenção:** o padrão "quais produtos usam o atributo X?" (inverso da junção) não é suportado pelas chaves atuais — exigiria um `Scan` ou um GSI. É um exemplo clássico de como novos padrões de acesso surgem e precisam ser planejados.

&nbsp;

---

&nbsp;

## Passo 4 — Single-Table Design

Até aqui temos **quatro tabelas separadas**: `stores`, `products_v2`, `global_attributes` e `product_attribute_values`. Cada padrão de acesso que cruza entidades exige múltiplas chamadas ao DynamoDB.

O **single-table design** é a prática de consolidar todas as entidades em uma única tabela, usando chaves e prefixos para distinguir os tipos de item.

&nbsp;

### A tabela unificada

Usamos nomes genéricos para as chaves (`PK` e `SK`) e prefixos de entidade para organizar os itens:

```
Tabela: mentorship_store  (única tabela)

PK                          SK                          Atributos extras
─────────────────────────── ─────────────────────────── ────────────────────────────────
STORE#store_ABC             #METADATA                   name="Loja ABC"
STORE#store_XYZ             #METADATA                   name="Loja XYZ"
STORE#store_ABC             PROD#5449000000996           name="Coca Cola", barcode="..."
STORE#store_ABC             PROD#7622300441937           name="KitKat", barcode="..."
STORE#store_XYZ             PROD#5449000000996           name="Coca Cola", barcode="..."
PROD#store_ABC#5449000000996  ATTR#color                value="Vermelho"
PROD#store_ABC#5449000000996  ATTR#size                 value="350ml"
ATTR#color                  #METADATA                   name="Cor", type="STRING"
ATTR#flavor                 #METADATA                   name="Sabor", type="STRING"
```

```bash
aws dynamodb create-table \
  --table-name mentorship_store \
  --attribute-definitions \
    AttributeName=PK,AttributeType=S \
    AttributeName=SK,AttributeType=S \
  --key-schema \
    AttributeName=PK,KeyType=HASH \
    AttributeName=SK,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

&nbsp;

### Padrões de acesso na tabela única

| Padrão de acesso | PK | SK / condição |
|---|---|---|
| Buscar uma loja | `STORE#<id>` | `SK = #METADATA` |
| Listar produtos de uma loja | `STORE#<id>` | `SK begins_with PROD#` |
| Buscar produto específico | `STORE#<id>` | `SK = PROD#<barcode>` |
| Listar atributos de um produto | `PROD#<storeId>#<barcode>` | `SK begins_with ATTR#` |
| Buscar definição de atributo global | `ATTR#<id>` | `SK = #METADATA` |

&nbsp;

### Prós e contras

**✅ Vantagens**

- **Menos round-trips:** em muitos casos, um único `Query` retorna dados de múltiplas entidades relacionadas (ex: loja + seus produtos)
- **Menos infraestrutura:** uma tabela para gerenciar, monitorar, fazer backup e pagar
- **Performance previsível:** sem JOINs nem transações entre tabelas; tudo na mesma partição é resolvido em O(1) ou O(log n)
- **Custo:** o DynamoDB cobra por leitura/escrita de item — consolidar reduz o overhead por operação

**❌ Desvantagens**

- **Complexidade cognitiva:** uma tabela com dezenas de tipos de item é difícil de entender, documentar e debugar
- **Sem schema enforcement:** nada impede que um item com `PK=STORE#...` tenha campos que deveriam ser exclusivos de produtos
- **Migrações dolorosas:** mudar a estrutura de chaves exige reescrever e reprocessar todos os itens afetados
- **Amarrado aos padrões de acesso:** novos padrões que não se encaixam nas chaves existentes podem exigir remodeling completo
- **Difícil de testar em isolamento:** não é possível fazer `Scan` apenas nas entidades de um tipo sem filtros adicionais

&nbsp;

### Quando **não** usar single-table

- Times diferentes gerenciam entidades diferentes — uma tabela compartilhada cria acoplamento organizacional
- O sistema precisa de relatórios ou queries analíticas ad-hoc — ferramentas como Athena e Redshift trabalham melhor com tabelas separadas
- A equipe está aprendendo DynamoDB — single-table aumenta a curva de aprendizado significativamente
- **A tabela mistura dados com tipos e frequências de acesso distintas** — misturar dados normais da aplicação com logs pode resultar em problemas de performance

&nbsp;

### Resumo dos conceitos abordados

| Conceito | Conclusão |
|---|---|
| Design orientado a padrões | Defina os acessos antes do schema |
| PK como organizador de entidades | A PK determina o que pode ser consultado em conjunto |
| Um-para-muitos | PK da entidade pai + SK da entidade filha na mesma tabela |
| Muitos-para-muitos | Tabela de junção com PK de um lado e SK do outro |
| Single-table design | Uma tabela, chaves genéricas, prefixos por entidade |
| Prós do single-table | Menos round-trips, menos infra, custo menor |
| Contras do single-table | Complexidade, rigidez, difícil migração |

&nbsp;

---

&nbsp;

> **Próximo passo:** executar as queries ao vivo em [`index.ts`](./index.ts).
