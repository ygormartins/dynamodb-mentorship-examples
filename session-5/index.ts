import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  TransactWriteCommand,
  TransactGetCommand,
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
// Schemas
// ---------------------------------------------------------------------------

const StoreSchema = z.object({
  PK: z.string(),
  SK: z.string(),
  id: z.string(),
  name: z.string(),
  entity: z.literal("store"),
});

const ProductSchema = z.object({
  PK: z.string(),
  SK: z.string(),
  name: z.string(),
  barcode: z.string(),
  entity: z.literal("product"),
  createdAt: z.string(),
  stock: z.number().optional(),
  version: z.number().optional(),
  views: z.number().optional(),
  expiresAt: z.number().optional(),
});

type Store = z.infer<typeof StoreSchema>;
type Product = z.infer<typeof ProductSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createStore = async (name: string): Promise<Store> => {
  const storeId = uuidv4();
  const store: Store = {
    PK: `STORE#${storeId}`,
    SK: `STORE#${storeId}`,
    id: storeId,
    name,
    entity: "store",
  };
  await documentClient.send(
    new PutCommand({ TableName: globalTable, Item: store })
  );
  return store;
};

const createProduct = async (
  storeId: string,
  name: string,
  barcode: string,
  stock: number
): Promise<Product> => {
  const product: Product = {
    PK: `STORE#${storeId}`,
    SK: `PROD#${barcode}`,
    name,
    barcode,
    entity: "product",
    createdAt: new Date().toISOString(),
    stock,
    version: 1,
    views: 0,
  };
  await documentClient.send(
    new PutCommand({ TableName: globalTable, Item: product })
  );
  return product;
};

const getProduct = async (
  storeId: string,
  barcode: string,
  consistentRead = false
) => {
  const result = await documentClient.send(
    new GetCommand({
      TableName: globalTable,
      Key: { PK: `STORE#${storeId}`, SK: `PROD#${barcode}` },
      // ConsistentRead: true garante que a leitura reflete a escrita mais recente.
      // Custo: 1 RCU (vs 0.5 RCU da leitura eventual).
      // Útil imediatamente após uma escrita crítica.
      ConsistentRead: consistentRead,
    })
  );
  return ProductSchema.safeParse(result.Item);
};

// ---------------------------------------------------------------------------
// Passo 1 — Consistência de dados
// ---------------------------------------------------------------------------

async function demoConsistency(storeId: string, barcode: string) {
  console.log("=== Passo 1: Consistência ===\n");

  // Leitura eventual (padrão) — pode retornar dado ligeiramente desatualizado
  const eventual = await getProduct(storeId, barcode, false);
  console.log(
    "Leitura eventual:",
    eventual.success ? eventual.data.name : "não encontrado"
  );

  // Leitura forte — garante o valor mais recente; custa 2× RCUs
  const strong = await getProduct(storeId, barcode, true);
  console.log(
    "Leitura forte:   ",
    strong.success ? strong.data.name : "não encontrado"
  );
}

// ---------------------------------------------------------------------------
// Passo 2 — Escritas condicionais
// ---------------------------------------------------------------------------

async function demoConditionalWrites(storeId: string) {
  console.log("\n=== Passo 2: Escritas Condicionais ===\n");

  const barcode = "0000000000001";

  // --- attribute_not_exists: cria somente se não existir ---
  // Primeira tentativa: deve ter sucesso
  try {
    await documentClient.send(
      new PutCommand({
        TableName: globalTable,
        Item: {
          PK: `STORE#${storeId}`,
          SK: `PROD#${barcode}`,
          name: "Produto Único",
          barcode,
          entity: "product",
          createdAt: new Date().toISOString(),
          stock: 10,
          version: 1,
        },
        // Garante que não existe nenhum item com esta PK+SK.
        // Sem isso, PutItem substituiria silenciosamente um item existente.
        ConditionExpression: "attribute_not_exists(PK)",
      })
    );
    console.log("✅ Produto criado com sucesso (primeira vez)");
  } catch {
    console.log("❌ Produto já existe (não deveria chegar aqui)");
  }

  // Segunda tentativa com a mesma chave: deve falhar
  try {
    await documentClient.send(
      new PutCommand({
        TableName: globalTable,
        Item: {
          PK: `STORE#${storeId}`,
          SK: `PROD#${barcode}`,
          name: "Produto Duplicado",
          barcode,
          entity: "product",
          createdAt: new Date().toISOString(),
          stock: 99,
          version: 1,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      })
    );
    console.log("✅ Produto criado (não deveria chegar aqui)");
  } catch {
    // ConditionalCheckFailedException — item já existe, escrita bloqueada
    console.log(
      "✅ Segunda criação bloqueada corretamente (ConditionalCheckFailedException)"
    );
  }

  // --- Locking otimista com campo version ---
  // Simula dois "clientes" que leram version=1 e tentam atualizar ao mesmo tempo
  const updateWithVersion = (newName: string, expectedVersion: number) =>
    documentClient.send(
      new UpdateCommand({
        TableName: globalTable,
        Key: { PK: `STORE#${storeId}`, SK: `PROD#${barcode}` },
        UpdateExpression: "SET #name = :name, version = :newVersion",
        // A escrita só ocorre se version no banco ainda for o valor que lemos.
        // Se outra requisição já incrementou version, esta falha — sem dados corrompidos.
        ConditionExpression: "version = :expectedVersion",
        ExpressionAttributeNames: { "#name": "name" },
        ExpressionAttributeValues: {
          ":name": newName,
          ":newVersion": expectedVersion + 1,
          ":expectedVersion": expectedVersion,
        },
      })
    );

  // Cliente A atualiza primeiro — sucesso
  try {
    await updateWithVersion("Nome Atualizado por A", 1);
    console.log("✅ Cliente A atualizou com sucesso (version 1 → 2)");
  } catch {
    console.log("❌ Cliente A falhou (não esperado)");
  }

  // Cliente B tenta atualizar com a mesma version=1 — conflito detectado
  try {
    await updateWithVersion("Nome Atualizado por B", 1);
    console.log("❌ Cliente B atualizou (não deveria — version já é 2)");
  } catch {
    console.log(
      "✅ Cliente B bloqueado corretamente (version mudou — ConditionalCheckFailedException)"
    );
  }
}

// ---------------------------------------------------------------------------
// Passo 3 — Contadores atômicos
// ---------------------------------------------------------------------------

async function demoAtomicCounters(storeId: string, barcode: string) {
  console.log("\n=== Passo 3: Contadores Atômicos ===\n");

  // ADD é atômico no servidor — sem race condition entre requisições concorrentes.
  // Equivalente a stock = stock + delta, mas garantido sem leitura prévia.
  const incrementViews = () =>
    documentClient.send(
      new UpdateCommand({
        TableName: globalTable,
        Key: { PK: `STORE#${storeId}`, SK: `PROD#${barcode}` },
        UpdateExpression: "ADD #views :delta",
        ExpressionAttributeNames: { "#views": "views" },
        ExpressionAttributeValues: { ":delta": 1 },
      })
    );

  // Simula 3 visualizações simultâneas — cada ADD é independente e seguro
  await Promise.all([incrementViews(), incrementViews(), incrementViews()]);
  console.log("✅ 3 visualizações registradas atomicamente");

  const after = await getProduct(storeId, barcode, true);
  console.log(`   views agora: ${after.success ? after.data.views : "?"}`);

  // Decrementa estoque com condição de guarda (não permite ficar negativo)
  try {
    await documentClient.send(
      new UpdateCommand({
        TableName: globalTable,
        Key: { PK: `STORE#${storeId}`, SK: `PROD#${barcode}` },
        UpdateExpression: "ADD stock :delta",
        // Garante que há pelo menos 1 unidade antes de decrementar.
        // Sem isso, ADD poderia deixar stock negativo.
        ConditionExpression: "stock >= :minStock",
        ExpressionAttributeValues: { ":delta": -1, ":minStock": 1 },
      })
    );
    console.log("✅ Estoque decrementado com sucesso");
  } catch {
    console.log("❌ Estoque insuficiente — operação bloqueada");
  }

  const afterStock = await getProduct(storeId, barcode, true);
  console.log(
    `   stock agora: ${afterStock.success ? afterStock.data.stock : "?"}`
  );
}

// ---------------------------------------------------------------------------
// Passo 4 — Transações
// ---------------------------------------------------------------------------

async function demoTransactions(
  storeAId: string,
  storeBId: string,
  barcode: string
) {
  console.log("\n=== Passo 4: Transações ===\n");

  // Garante que a Loja B tem o produto (para poder receber estoque via transação)
  (await documentClient
    .send(
      new PutCommand({
        TableName: globalTable,
        Item: {
          PK: `STORE#${storeBId}`,
          SK: `PROD#${barcode}`,
          name: "Coca Cola",
          barcode,
          entity: "product",
          createdAt: new Date().toISOString(),
          stock: 0,
          version: 1,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      })
    )
    .catch(() => {})) as never; // Ignora se já existir;

  // TransactWriteItems: decrementa estoque da Loja A e incrementa na Loja B atomicamente.
  // Se a Loja A não tiver estoque suficiente, NENHUMA das duas escritas é aplicada.
  try {
    await documentClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: globalTable,
              Key: { PK: `STORE#${storeAId}`, SK: `PROD#${barcode}` },
              UpdateExpression: "ADD stock :delta",
              // ConditionCheck dentro da transação: falha toda a transação se stock < 5
              ConditionExpression: "stock >= :minStock",
              ExpressionAttributeValues: { ":delta": -5, ":minStock": 5 },
            },
          },
          {
            Update: {
              TableName: globalTable,
              Key: { PK: `STORE#${storeBId}`, SK: `PROD#${barcode}` },
              UpdateExpression: "ADD stock :delta",
              ExpressionAttributeValues: { ":delta": 5 },
            },
          },
        ],
      })
    );
    console.log("✅ Transferência de 5 unidades: Loja A → Loja B concluída");
  } catch (err: unknown) {
    // TransactionCanceledException com razão ConditionalCheckFailed
    console.log("❌ Transferência cancelada — Loja A sem estoque suficiente");
    console.log("   Nenhuma das duas escritas foi aplicada (all-or-nothing)");
  }

  // TransactGetItems: lê os dois itens como um snapshot consistente.
  // Útil para verificar estoque de múltiplos itens sem risco de ler um dado pré-escrita
  // e outro pós-escrita de uma transação concorrente.
  const snapshot = await documentClient.send(
    new TransactGetCommand({
      TransactItems: [
        {
          Get: {
            TableName: globalTable,
            Key: { PK: `STORE#${storeAId}`, SK: `PROD#${barcode}` },
          },
        },
        {
          Get: {
            TableName: globalTable,
            Key: { PK: `STORE#${storeBId}`, SK: `PROD#${barcode}` },
          },
        },
      ],
    })
  );

  const [itemA, itemB] = snapshot.Responses ?? [];
  const prodA = ProductSchema.safeParse(itemA?.Item);
  const prodB = ProductSchema.safeParse(itemB?.Item);

  console.log(`   Loja A stock: ${prodA.success ? prodA.data.stock : "?"}`);
  console.log(`   Loja B stock: ${prodB.success ? prodB.data.stock : "?"}`);
}

// ---------------------------------------------------------------------------
// Passo 5 — TTL
// ---------------------------------------------------------------------------

async function demoTtl(storeId: string, barcode: string) {
  console.log("\n=== Passo 5: TTL ===\n");

  // TTL é um Unix timestamp em segundos.
  // O DynamoDB deleta o item automaticamente após esse momento (delay de até ~48h).
  // Deleções por TTL não consomem WCUs.
  const expiresAt = Math.floor(Date.now() / 1000) + 60; // expira em 60 segundos

  await documentClient.send(
    new PutCommand({
      TableName: globalTable,
      Item: {
        PK: `STORE#${storeId}`,
        SK: `PROMO#${barcode}`,
        entity: "promotion",
        barcode,
        discount: 15,
        // expiresAt deve ser configurado como atributo TTL na tabela (via update-time-to-live).
        // Após o timestamp, o DynamoDB deleta o item automaticamente.
        expiresAt,
      },
    })
  );

  const expiresDate = new Date(expiresAt * 1000).toISOString();
  console.log(`✅ Promoção criada — expira automaticamente em: ${expiresDate}`);

  // Atenção: itens expirados podem ainda aparecer em queries por até ~48h.
  // Para filtrar com precisão, use FilterExpression com o timestamp atual:
  console.log(
    "   Dica: filtre itens expirados com FilterExpression: expiresAt > :now"
  );
  console.log(`   :now = ${Math.floor(Date.now() / 1000)}`);
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

async function main() {
  const storeA = await createStore("Loja A");
  const storeB = await createStore("Loja B");

  const barcode = "5449000000996";
  await createProduct(storeA.id, "Coca Cola", barcode, 20);

  // await demoConsistency(storeA.id, barcode);
  // await demoConditionalWrites(storeA.id);
  // await demoAtomicCounters(storeA.id, barcode);
  // await demoTransactions(storeA.id, storeB.id, barcode);
  // await demoTtl(storeA.id, barcode);
}

main();
