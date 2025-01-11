# `const` fcgi

[Documentation Index](../README.md)

```ts
import {fcgi} from "https://deno.land/x/fcgi@v2.1.0/mod.ts"
```

`const` fcgi: [Fcgi](../class.Fcgi/README.md)

`Fcgi` class provides top-level API, above `Server` and `Client`, and `fcgi` is the default instance of `Fcgi` to be used most of the time.

```ts
// Create FastCGI backend server (another HTTP server will send requests to us)

fcgi.listen
(	8989,
	'/page-1.html',
	async req =>
	{	await req.respond({body: 'Hello world'});
	}
);
```

Another example:

```ts
// Create FastCGI client for PHP.
// Stop your existing PHP-FPM service, setup `PHP_POOL_CONFIG_FILE` and `DOCUMENT_ROOT` variables, and run this code.
// This code creates PHP-FPM capable HTTP server.

import {listenAndServe} from 'https://deno.land/std@0.135.0/http/server.ts';

const PHP_POOL_CONFIG_FILE = '/etc/php/7.4/fpm/pool.d/www.conf';
const DOCUMENT_ROOT = '/var/www/deno-server-root';

// Read PHP service address from it's configuration file
const HTTTP_LISTEN = ':8081';
const CONF = Deno.readTextFileSync(PHP_POOL_CONFIG_FILE);
const PHP_LISTEN = CONF.match(/(?:^|\r|\n)\s{0,}listen\s{0,}=\s{0,}(\S+)/)?.[1];

if (PHP_LISTEN)
{	listenAndServe
	(	HTTTP_LISTEN,
		async (request) =>
		{	console.log(`Request: ${request.url}`);
			let url = new URL(request.url);
			if (url.pathname.endsWith('.php'))
			{	try
				{	// Fetch from PHP
					let response = await fcgi.fetch
					(	{	addr: PHP_LISTEN,
							params: new Map
							(	Object.entries
								(	{	DOCUMENT_ROOT,
										SCRIPT_FILENAME: DOCUMENT_ROOT+url.pathname, // response will be successful if such file exists
									}
								)
							),
						},
						url, // URL of the request that PHP will see
						{	method: request.method,
							body: request.body,
						}
					);
					console.log(response);

					// Pass the response to deno server
					return new Response
					(	response.body,
						{	status: response.status,
							headers: response.headers,
						}
					);
				}
				catch (e)
				{	console.error(e);
					return new Response('', {status: 500});
				}
			}
			else
			{	return new Response('Resource not found', {status: 404});
			}
		}
	);
}
```

