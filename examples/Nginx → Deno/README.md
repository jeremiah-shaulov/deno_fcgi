## Example of how to use x/fcgi with Nginx HTTP server

This example demonstrates Docker infrastructure with [2 services](./docker-compose.yaml): `http_service` and `deno_service`.

The `http_service` contains Nginx server with [such configuration](./infra/http_service/default.conf):

```nginx
server
{	listen 80;
	listen [::]:80;
	server_name http_service;

	root /usr/src/app;
	index index.php;

	location /
	{	fastcgi_pass deno_service:9988;
		include fastcgi_params;
		fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
	}
}
```

This configuration tells Nginx to forward HTTP requests on port 80 to host called `deno_service` port `9988`.

The `deno_service` contains [Deno app](./src/deno_service/backend.ts) that serves FastCGI requests on port `9988`.

To start these 2 services in background on your computer, do:

```
HTTP_PORT=8123 docker-compose up -d --build
```

Then you can open http://localhost:8123/ in your browser, and see how it works.

To stop the services:

```
docker-compose down
```

You need [Docker](https://www.docker.com/) to be installed.
