import {Application, fcgi} from './private/deps.ts';

const DOCUMENT_ROOT = '/usr/src/php_fpm_service';

const app = new Application;

app.use
(	async ctx =>
	{	const resp = await fcgi.fetch
		(	{	addr: 'php_fpm_service:9000',
				scriptFilename: DOCUMENT_ROOT+ctx.request.url.pathname,
			},
			new Request
			(	ctx.request.url.href,
				{	method: ctx.request.method,
					headers: ctx.request.headers,
					body: ctx.request.hasBody ? ctx.request.body({type: 'stream'}).value : undefined,
				}
			)
		);
		ctx.response.status = resp.status;
		ctx.response.headers = resp.headers;
		ctx.response.body = resp.body;
	}
);

app.listen('deno_service:80');
console.log(`Started on http://deno_service:80`);
