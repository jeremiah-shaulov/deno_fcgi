## Example of how to use x/fcgi with Apache2 HTTP server

This example demonstrates Docker infrastructure with [2 services](./docker-compose.yaml): `http_service` and `deno_service`.

The `http_service` contains Apache2 server with [such configuration](./infra/http_service/http_service.conf):

```apache
LoadModule proxy_module modules/mod_proxy.so
LoadModule proxy_fcgi_module modules/mod_proxy_fcgi.so

<VirtualHost *:80>
	ServerName http_service
	SetHandler "proxy:fcgi://deno_service:9988"
</VirtualHost>
```

This configuration tells Apache to forward HTTP requests on port 80 to host called `deno_service` port `9988`.

The `deno_service` contains [Deno app](./src/deno_service/backend.ts) that serves FastCGI requests on port `9988`.

To start these 2 services in background on your computer, do:

```bash
# from directory that contains docker-compose.yaml
HTTP_PORT=8123 docker-compose up -d --build
```

Then you can open http://localhost:8123/ in your browser, and see how it works.

To stop the services:

```bash
# from directory that contains docker-compose.yaml
docker-compose down
```

You need [Docker](https://www.docker.com/) to be installed.

## Without Docker

1. To configure Apache2 on host machine, use this configuration:

```apache
<VirtualHost *:80>
	ServerName deno-server.loc
	SetHandler "proxy:fcgi://deno_service:9988"
</VirtualHost>
```

2. Enable module called "proxy_fcgi":

```bash
sudo a2enmod proxy_fcgi`
sudo systemctl reload apache2
```

3. To use fake domain name `deno-server.loc` from localhost, add it to `/etc/hosts`:

```
::1	deno-server.loc
```

4. Run Deno application like this:

```bash
deno run --allow-net main.ts
```

If we want to listen on unix-domain socket, we can use such "SetHandler" directive:

```apache
	SetHandler "proxy:unix:/run/deno-server/main.sock|fcgi://localhost"
```

And use socket node path in `fcgi.listen()`.

```ts
// ...
fcgi.listen
(	'/run/deno-server/main.sock',
	'',
	async req =>
	{	// ...
	}
);
```

But there will be 1 problem. Deno script creates socket node and sets it's owner and group to the user from which you run Deno.
And Apache user (`www-data`) will not be able to connect.
Changing socket group after starting Deno application can solve the problem.
You can use this script to start deno application:

```bash
APACHE_USER=www-data

sudo mkdir /run/deno-server
sudo chown "$USER:" /run/deno-server
deno run --allow-read --allow-write main.ts & sleep 3 && sudo chown "$USER:$APACHE_USER" /run/deno-server/main.sock; fg
```
