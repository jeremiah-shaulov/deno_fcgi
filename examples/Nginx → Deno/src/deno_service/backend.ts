import {fcgi} from './private/deps.ts';

const listener = fcgi.listen
(	'deno_service:9988', // FastCGI service will listen on this address
	'', // Handle all URL paths
	async req =>
	{	// Handle the request
		console.log(req.url);
		req.responseHeaders.set('Content-Type', 'text/html');
		await req.respond({body: 'Hello world!'});
	}
);

console.log(`Started on ${listener.addr.transport=='tcp' ? listener.addr.hostname+':'+listener.addr.port : listener.addr.transport}`);
