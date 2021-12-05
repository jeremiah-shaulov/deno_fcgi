FROM php:8.0-fpm as base

# 1. Create user for this service
RUN groupadd -g 1000 php_fpm_service_user && \
	useradd -u 1000 -g php_fpm_service_user -s /bin/false php_fpm_service_user

# 2. Copy my version of www.conf
COPY ./infra/php_fpm_service/www.conf /usr/local/etc/php-fpm.d/www.conf

# 3. Copy the app
COPY --chown=root:php_fpm_service_user ./src/php_fpm_service /usr/src/php_fpm_service

USER php_fpm_service_user
EXPOSE 9000
