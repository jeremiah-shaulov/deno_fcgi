FROM httpd:2.4

# 1. Copy server conf
RUN echo 'Include conf/extra/http_service.conf' | tee -a /usr/local/apache2/conf/httpd.conf
COPY ./infra/http_service/http_service.conf conf/extra/http_service.conf

EXPOSE 80
