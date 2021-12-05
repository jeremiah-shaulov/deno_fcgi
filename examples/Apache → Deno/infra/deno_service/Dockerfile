FROM denoland/deno:debian-1.16.2

# 1. Source code will be copied to here.
WORKDIR /usr/src/deno_service

# 2. Run from this user.
USER deno

# 3. To improve build time, copy deps.ts, and cache the app dependencies.
COPY --chown=root:root ./src/deno_service/private/deps.ts ./private/deps.ts
RUN deno cache --unstable ./private/deps.ts

# 4. Copy the app and cache it. Also cache all *.test.ts files if such are found.
COPY --chown=root:root ./src/deno_service .
RUN deno cache --unstable backend.ts && \
	find . -name '*.test.ts' | xargs --no-run-if-empty deno cache --unstable

CMD ["run", "--unstable", "--allow-net", "backend.ts"]
EXPOSE 9988
