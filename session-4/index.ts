import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from "uuid";
import z from "zod";

const dynamoClient = new DynamoDBClient({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const documentClient = DynamoDBDocumentClient.from(dynamoClient);

const globalTable = "mentorship_store";

// ---------------------------------------------------------------------------
// Schemas Zod — evoluídos da sessão 3 com o campo createdAt
// ---------------------------------------------------------------------------

const StoreSchema = z.object({
  name: z.string(),
  entity: z.literal("store"),
  PK: z.string(),
  SK: z.string(),
  id: z.string(),
  // createdAt é opcional nas stores para demonstrar o sparse index:
  // stores sem createdAt não aparecerão no GSI store-products-by-date
  createdAt: z.string().optional(),
});

const ProductSchema = z.object({
  name: z.string(),
  barcode: z.string(),
  entity: z.literal("product"),
  PK: z.string(),
  SK: z.string(),
  // createdAt é obrigatório nos produtos — é a SK do GSI store-products-by-date.
  // Sem esse campo, o produto não seria indexado (sparse index).
  // Usamos ISO 8601 UTC: strings nesse formato ordenam lexicograficamente = cronologicamente.
  createdAt: z.string(),
});

type Store = z.infer<typeof StoreSchema>;
type Product = z.infer<typeof ProductSchema>;

// Union discriminada — permite identificar o tipo de entidade pelo campo "entity"
const Entity = z.discriminatedUnion("entity", [StoreSchema, ProductSchema]);
type Entity = z.infer<typeof Entity>;

// ---------------------------------------------------------------------------
// Funções base
// ---------------------------------------------------------------------------

// Cria uma store. Sem createdAt intencional — demonstra que stores não aparecem
// no GSI store-products-by-date (sparse index automático)
const createStore = async (name: string): Promise<Store> => {
  const storeId = uuidv4();

  const store: Store = {
    PK: `STORE#${storeId}`,
    SK: `STORE#${storeId}`,
    name,
    entity: "store",
    id: storeId,
  };

  await documentClient.send(new PutCommand({ TableName: globalTable, Item: store }));

  return store;
};

// Cria um produto com createdAt explícito para permitir controle sobre a ordenação no demo.
// Em produção, seria: new Date().toISOString()
const createProduct = async (
  storeId: string,
  name: string,
  barcode: string,
  createdAt: string
): Promise<Product> => {
  const product: Product = {
    PK: `STORE#${storeId}`,
    SK: `PROD#${barcode}`,
    name,
    barcode,
    entity: "product",
    // createdAt é a Sort Key do GSI store-products-by-date.
    // ISO 8601 UTC garante ordenação correta como string — "2024-01-01T..." < "2024-03-01T..."
    createdAt,
  };

  await documentClient.send(new PutCommand({ TableName: globalTable, Item: product }));

  return product;
};

// ---------------------------------------------------------------------------
// Passo 4 — GSI: entity-index
//
// GSI PK: entity  →  "store" | "product"
// GSI SK: SK      →  valor da SK da tabela base
//
// Permite listar todos os itens de um tipo específico independente da partição base.
// Sem esse GSI, listar todos os produtos exigiria um Scan na tabela inteira.
// ---------------------------------------------------------------------------

const listAllProducts = async (): Promise<Product[]> => {
  const items: Product[] = [];
  let lastKey: Record<string, unknown> | undefined;

  // Paginação manual: o DynamoDB retorna até 1MB por chamada.
  // LastEvaluatedKey indica que há mais resultados — continuamos até ele ser undefined.
  do {
    const result = await documentClient.send(
      new QueryCommand({
        TableName: globalTable,
        IndexName: "entity-index",
        KeyConditionExpression: "entity = :e",
        ExpressionAttributeValues: { ":e": "product" },
        ExclusiveStartKey: lastKey,
      })
    );

    for (const item of result.Items ?? []) {
      const parsed = ProductSchema.safeParse(item);
      if (parsed.success) items.push(parsed.data);
    }

    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  return items;
};

const listAllStores = async (): Promise<Store[]> => {
  // Mesmo GSI (entity-index), mesmo padrão — só muda o valor de entity.
  // Demonstra que um único índice serve para múltiplos tipos de entidade.
  const result = await documentClient.send(
    new QueryCommand({
      TableName: globalTable,
      IndexName: "entity-index",
      KeyConditionExpression: "entity = :e",
      ExpressionAttributeValues: { ":e": "store" },
    })
  );

  return (result.Items ?? []).flatMap((item) => {
    const parsed = StoreSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
};

// ---------------------------------------------------------------------------
// Passo 5 — GSI: store-products-by-date
//
// GSI PK: PK         →  "STORE#<id>" (mesma PK da tabela base)
// GSI SK: createdAt  →  ISO 8601 UTC
//
// Permite listar produtos de uma loja ordenados por data de criação.
// Sem esse GSI, a SK base (PROD#<barcode>) ordena por barcode — não por data.
//
// Note: este GSI tem a mesma PK da tabela base — seria um candidato a LSI,
// mas a tabela já existe sem LSIs definidos. Isso ilustra o trade-off real:
// LSIs devem ser planejados antes da criação da tabela.
// ---------------------------------------------------------------------------

const listProductsByStoreSortedByDate = async (
  storeId: string,
  order: "asc" | "desc" = "asc"
): Promise<Product[]> => {
  const result = await documentClient.send(
    new QueryCommand({
      TableName: globalTable,
      IndexName: "store-products-by-date",
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": `STORE#${storeId}` },
      // ScanIndexForward: true = ascendente (mais antigo primeiro)
      // ScanIndexForward: false = descendente (mais recente primeiro)
      ScanIndexForward: order !== "desc",
    })
  );

  return (result.Items ?? []).flatMap((item) => {
    const parsed = ProductSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
};

const listProductsByStoreAfterDate = async (
  storeId: string,
  since: string
): Promise<Product[]> => {
  // Condição de range na SK do GSI: retorna apenas produtos criados após `since`.
  // ISO 8601 UTC funciona como range key porque ordena lexicograficamente = cronologicamente.
  const result = await documentClient.send(
    new QueryCommand({
      TableName: globalTable,
      IndexName: "store-products-by-date",
      KeyConditionExpression: "PK = :pk AND createdAt >= :since",
      ExpressionAttributeValues: {
        ":pk": `STORE#${storeId}`,
        ":since": since,
      },
      ScanIndexForward: false,
    })
  );

  return (result.Items ?? []).flatMap((item) => {
    const parsed = ProductSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
};

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

async function main() {
  // Seed: 2 stores e 4 produtos com datas de criação escalonadas
  const store1 = await createStore("Loja ABC");
  const store2 = await createStore("Loja XYZ");

  // Produtos da store1 — datas escalonadas para demonstrar ordenação
  const product1 = await createProduct(store1.id, "Coca Cola", "5449000000996", "2024-01-10T08:00:00Z");
  const product2 = await createProduct(store1.id, "KitKat",    "7622300441937", "2024-03-22T14:45:00Z");
  const product3 = await createProduct(store1.id, "Nescafé",   "7613036809213", "2024-06-01T09:30:00Z");

  // Produto da store2 — mesmo barcode da Coca Cola, partição diferente
  const product4 = await createProduct(store2.id, "Coca Cola", "5449000000996", "2024-02-05T11:20:00Z");

  console.log("Seed concluído.\n");

  // --- Passo 4: entity-index ---

  // listAllProducts usa o GSI entity-index (PK = entity).
  // Retorna produtos de AMBAS as stores em uma única Query — impossível com a tabela base.
  const allProducts = await listAllProducts();
  console.log(`[entity-index] Todos os produtos (${allProducts.length} itens):`);
  allProducts.forEach((p) => console.log(`  ${p.PK} | ${p.SK} | ${p.name}`));

  console.log();

  // listAllStores usa o mesmo GSI com entity = "store"
  const allStores = await listAllStores();
  console.log(`[entity-index] Todas as stores (${allStores.length} itens):`);
  allStores.forEach((s) => console.log(`  ${s.PK} | ${s.name}`));

  // Demonstração do sparse index: stores não têm createdAt → não aparecem em store-products-by-date
  console.log(`\n  → Stores têm createdAt? ${allStores.every((s) => !s.createdAt) ? "Não — sparse index em ação" : "Sim"}`);

  console.log();

  // --- Passo 5: store-products-by-date ---

  // Produtos da store1 do mais recente para o mais antigo
  const byDateDesc = await listProductsByStoreSortedByDate(store1.id, "desc");
  console.log(`[store-products-by-date] Produtos da store1, mais recentes primeiro:`);
  byDateDesc.forEach((p) => console.log(`  ${p.createdAt} | ${p.name}`));

  console.log();

  // Apenas produtos criados depois de fevereiro de 2024
  const afterFeb = await listProductsByStoreAfterDate(store1.id, "2024-02-01T00:00:00Z");
  console.log(`[store-products-by-date] Produtos da store1 após 2024-02-01 (${afterFeb.length} itens):`);
  afterFeb.forEach((p) => console.log(`  ${p.createdAt} | ${p.name}`));
}

main();
