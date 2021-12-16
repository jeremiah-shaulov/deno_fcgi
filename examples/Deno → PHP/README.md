## Example of how to use x/fcgi with PHP-FPM

This example demonstrates Docker infrastructure with [2 services](./docker-compose.yaml): `deno_service` and `php_fpm_service`.

The `deno_service` contains HTTP server implemented in Deno, that forwards requests to host called `php_fpm_service` port `9000`.

The `php_fpm_service` has PHP-FPM installation with [such configuration](./infra/php_fpm_service/www.conf):

```ini
[www]
user = php_fpm_service_user
group = php_fpm_service_user
listen = php_fpm_service:9000
pm = dynamic
pm.max_children = 200
pm.start_servers = 1
pm.min_spare_servers = 1
pm.max_spare_servers = 5
```

There's only 1 page in the `php_fpm_service` [directory](./src/php_fpm_service/) called `page-1.php`.

To start these 2 services in background on your computer, do:

```bash
# from directory that contains docker-compose.yaml
HTTP_PORT=8123 docker-compose up -d --build
```

Then you can open http://localhost:8123/page-1.php in your browser, and see how it works.

To stop the services:

```bash
# from directory that contains docker-compose.yaml
docker-compose down
```

You need [Docker](https://www.docker.com/) to be installed.
