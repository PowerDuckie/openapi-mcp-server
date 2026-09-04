
import { parseSpecContent, generateTools, generatePrompts, generateResources } from "./src/index.js";

const specText = `
openapi: 3.1.0
info:
  title: Demo API
  version: 1.0.0
servers:
  - url: https://api.example.com/v1
paths:
  /users/{id}:
    get:
      operationId: getUser
      summary: Get a user by ID
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
`;

async function main(): Promise<void> {
  const spec = await parseSpecContent(specText, true);
  console.log("Tools:", generateTools(spec));
  console.log("Prompts:", generatePrompts(spec));
  console.log("Resources:", generateResources(spec));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
