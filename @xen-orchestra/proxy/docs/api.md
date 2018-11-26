The API is [JSON-RPC 2.0](https://www.jsonrpc.org/specification) over HTTP.

## Introspection

```ts
declare function systemlistMethods
```
- `system.listMethods(): string[]`
- `system.methodSignature(name: string): { params: }`
