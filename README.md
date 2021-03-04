# deno_fcgi
FastCGI implementation for Deno

## Example

```ts
import {Server} from './mod.ts';

let listener = Deno.listen({transport: 'unix', path: '/tmp/deno-fcgi.sock'});
const server = new Server(listener);
console.log(`Started`);

for await (let req of server)
{	console.log(req.url);
	let buffer = await Deno.readAll(req.body);
	console.log(new TextDecoder().decode(buffer));
	req.respond({body: 'Hello'});
}
```
