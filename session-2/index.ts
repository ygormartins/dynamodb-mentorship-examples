import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

const dynamoClient = new DynamoDBClient({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

// Criando um cliente DynamoDB com o DocumentClient para facilitar as operações com o DynamoDB
const documentClient = DynamoDBDocumentClient.from(dynamoClient);

async function main() {
  // Passo 2
  //
  // Exemplo de tabela:
  //
  // product_id (PK) | store_id     | name      | barcode
  // --------------- | ------------ | --------- | -------------
  // 5a484931211a    | f32193b0e3da | Coca Cola | 5449000000996

  // O GetCommand é usado para buscar um único item pelo seu ID
  const getProductByIdCommand = new GetCommand({
    TableName: "products",
    Key: {
      product_id: "5a484931211a", // Partition key, como foi definida quando a tabela foi criada
    },
  });

  const { Item: productExample1 } = await documentClient.send(
    getProductByIdCommand
  );

  console.log(productExample1);

  // Passo 3
  //
  // Exemplo de tabela:
  //
  // product_id (PK) | store_id     | name      | barcode
  // --------------- | ------------ | --------- | -------------
  // 5449000000996   | f32193b0e3da | Coca Cola | 5449000000996

  // Agora o ID foi simplificado para o código de barras,
  // podemos simplesmente usar o código de barras como a Partition key
  const getProductByBarcodeCommand = new GetCommand({
    TableName: "products",
    Key: {
      product_id: "5449000000996",
    },
  });

  // Porém, códigos de barras não são únicos, várias stores podem ter produtos com o mesmo código de barras,
  // então precisamos prefixar o código de barras com o store_id para garantir que seja único
  //
  // Tabela atualizada:
  //
  // product_id (PK)            | store_id     | name      | barcode
  // -------------------------- | ------------ | --------- | -------------
  // f32193b0e3da#5449000000996 | f32193b0e3da | Coca Cola | 5449000000996

  // Dessa forma, o código de barras é único e podemos usar como a Partition key
  // desde que o ID da store seja conhecido durante a consulta
  const getProductByStoreIdAndBarcodeCommand = new GetCommand({
    TableName: "products",
    Key: {
      product_id: "f32193b0e3da#5449000000996",
    },
  });

  const { Item: productExample2 } = await documentClient.send(
    getProductByStoreIdAndBarcodeCommand
  );

  console.log(productExample2);

  // Passo 4
  //
  // Tabela de exemplo:
  //
  // product_id (PK)            | store_id     | name      | barcode
  // -------------------------- | ------------ | --------- | -------------
  // f32193b0e3da#5449000000996 | f32193b0e3da | Coca Cola | 5449000000996

  // Uma alternativa é usar um ScanCommand e aplicar filtros:
  const scanStoreProducts = new ScanCommand({
    TableName: "products",
    FilterExpression: "store_id = :store_id",
    ExpressionAttributeValues: {
      ":store_id": "f32193b0e3da",
    },
  });

  // Porém, o ScanCommand é menos eficiente do que o QueryCommand,
  // pois ele percorre toda a tabela e aplica o filtro apenas no resultado final
  //
  // Uma alternativa é usar um QueryCommand com KeyConditionExpression, que é mais eficiente, porém
  // necessita que apenas apenas atributos chave sejam especificados no KeyConditionExpression.
  //
  // Nesse caso, precisamos também criar um campo de Sort Key (SK) para ordenar os resultados
  //
  // Tabela de exemplo:
  //
  // PRIMARY KEY                     | ATTRIBUTES
  // ------------------------------- | -------------------------
  // store_id (PK) | product_id (SK) | name      | barcode
  // ------------- | --------------- | --------- | -------------
  // f32193b0e3da  | 5449000000996   | Coca Cola | 5449000000996
  //
  // Agora, ao invés de manualmente juntar o ID da store com o barcode,
  // usamos o PK + SK para criar uma chave primária composta pelos dois

  // Como o SK é opcional, mas ainda garante a unicidade do PK, podemos
  // usar o PK como chave única para buscar produtos por store
  const listProductsByStoreCommand = new QueryCommand({
    TableName: "products",
    KeyConditionExpression: "store_id = :store_id",
    ExpressionAttributeValues: {
      ":store_id": "f32193b0e3da",
    },
  });

  // O comando acima percorre apenas os itens que correspondem ao store_id,
  // sem precisar percorrer toda a tabela.

  const { Items: productsExample3 } = await documentClient.send(
    listProductsByStoreCommand
  );

  console.log(productsExample3);
}

main();
