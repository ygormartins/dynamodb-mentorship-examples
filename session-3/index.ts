import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
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

// Nome da tabela única (single-table design) que armazena todas as entidades
const globalTable = "mentorship_store";

// Schema de validação para a entidade Store usando Zod.
// O campo "entity" é um literal, o que permite distinguir Stores de outras entidades
// em uma union discriminada (ver abaixo)
const StoreSchema = z.object({
  name: z.string(),
  entity: z.literal("store"),
  PK: z.string(), // Partition Key: "STORE#{storeId}"
  SK: z.string(), // Sort Key: "STORE#{storeId}" (mesmo valor do PK para o item raiz da entidade)
  id: z.string(),
});

// Schema de validação para a entidade Product.
// Produtos compartilham a mesma PK da store (STORE#{storeId}),
// e usam o barcode como SK (PROD#{barcode}), permitindo queries por store
const ProductSchema = z.object({
  name: z.string(),
  barcode: z.string(),
  entity: z.literal("product"),
  PK: z.string(), // Partition Key: "STORE#{storeId}"
  SK: z.string(), // Sort Key: "PROD#{barcode}"
});

// Tipos TypeScript inferidos diretamente dos schemas Zod, garantindo consistência entre validação e tipagem
type Store = z.infer<typeof StoreSchema>;
type Product = z.infer<typeof ProductSchema>;

// Union discriminada: permite validar um item desconhecido da tabela e identificar
// se é uma Store ou um Product com base no campo "entity"
const Entity = z.discriminatedUnion("entity", [StoreSchema, ProductSchema]);

// Cria uma nova store na tabela do DynamoDB.
// O ID é gerado automaticamente com UUID v4 para garantir unicidade global
const createStore = async () => {
  const storeId = uuidv4();

  // Monta o item da store seguindo o padrão de chaveamento:
  // PK e SK iguais indicam que este é o "item raiz" da entidade (não um item filho)
  const store: Store = {
    PK: `STORE#${storeId}`,
    SK: `STORE#${storeId}`,
    name: "Acme Inc",
    entity: "store",
    id: storeId,
  };

  // PutCommand insere ou substitui completamente um item na tabela (equivalente ao INSERT OR REPLACE do SQL)
  const createStoreCommand = new PutCommand({
    TableName: globalTable,
    Item: store,
  });

  await documentClient.send(createStoreCommand);

  return store;
};

// Cria um novo produto associado a uma store existente.
// O produto herda a PK da store, o que permite listar todos os produtos de uma store
// com um único QueryCommand (PK = "STORE#{storeId}", SK begins_with "PROD#")
const createProduct = async (
  storeId: string,
  productName: string,
  productBarcode: string
) => {
  const product: Product = {
    PK: `STORE#${storeId}`,
    SK: `PROD#${productBarcode}`, // O barcode é usado como identificador único do produto dentro da store
    name: productName,
    entity: "product",
    barcode: productBarcode,
  };

  const createProductCommand = new PutCommand({
    TableName: globalTable,
    Item: product,
  });

  await documentClient.send(createProductCommand);

  return product;
};

// Busca um produto específico pelo ID da store e pelo barcode do produto.
// Usa GetCommand, que requer a chave primária completa (PK + SK) e retorna exatamente um item — O(1)
const getProductById = async (storeId: string, productId: string) => {
  const getProductCommand = new GetCommand({
    TableName: globalTable,
    Key: {
      PK: `STORE#${storeId}`,
      SK: `PROD#${productId}`,
    },
  });

  const { Item } = await documentClient.send(getProductCommand);

  // Valida o item retornado contra o ProductSchema.
  // safeParse não lança exceção — retorna { success, data } ou { success: false, error }
  // Isso garante que o item existe e tem a forma esperada antes de retorná-lo
  const { success, data } = ProductSchema.safeParse(Item);

  if (!success) throw new Error();

  return data;
};

async function main() {
  // Cria uma store e em seguida cria um produto associado a ela
  const store = await createStore();
  const product = await createProduct(store.id, "Test Product", "08974297429");

  // Busca o produto recém-criado pelo ID da store e pelo barcode
  const productById = await getProductById(store.id, product.barcode);

  console.log(productById);
}

main();
