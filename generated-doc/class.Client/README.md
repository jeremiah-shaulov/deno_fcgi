# `class` Client

[Documentation Index](../README.md)

```ts
import {Client} from "https://deno.land/x/fcgi@v2.1.1/mod.ts"
```

## This class has

- [constructor](#-constructoroptions-clientoptions)
- 7 methods:
[options](#-optionsoptions-clientoptions-clientoptions),
[onError](#-onerrorcallback-error-error--unknown-void),
[closeIdle](#-closeidle-void),
[fetch](#-fetchrequest_options-requestoptions-input-request--url--string-init-requestinit-promiseresponsewithcookies),
[fetchCapabilities](#-fetchcapabilitiesaddr-fcgiaddr--conn-promisefcgi_max_conns-number-fcgi_max_reqs-number-fcgi_mpxs_conns-number),
[canFetch](#-canfetch-boolean),
[waitCanFetch](#-waitcanfetch-promisevoid)


#### 🔧 `constructor`(options?: [ClientOptions](../interface.ClientOptions/README.md))



#### ⚙ options(options?: [ClientOptions](../interface.ClientOptions/README.md)): [ClientOptions](../interface.ClientOptions/README.md)

> Set and/or get configuration.



#### ⚙ onError(callback?: (error: Error) => `unknown`): `void`

> `onError(callback)` - catch general connection errors. Only one handler is active. Second `onError(callback2)` overrides the previous handler.
> `onError(undefined)` - removes the event handler.



#### ⚙ closeIdle(): `void`

> If `keepAliveTimeout` option was > 0, `fcgi.fetch()` will reuse connections. After each fetch, connection will wait for specified number of milliseconds for next fetch. Idle connections don't let Deno application from exiting naturally.
> You can call `fcgi.closeIdle()` to close all idle connections.



#### ⚙ fetch(request\_options: [RequestOptions](../interface.RequestOptions/README.md), input: Request | URL | `string`, init?: RequestInit): Promise\<[ResponseWithCookies](../class.ResponseWithCookies/README.md)>



#### ⚙ fetchCapabilities(addr: [FcgiAddr](../type.FcgiAddr/README.md) | [Conn](../interface.Conn/README.md)): Promise\<\{FCGI\_MAX\_CONNS?: `number`, FCGI\_MAX\_REQS?: `number`, FCGI\_MPXS\_CONNS?: `number`}>



#### ⚙ canFetch(): `boolean`

> When number of ongoing requests is more than the configured value (`maxConns`), `fetch()` and `fetchCapabilities()` will wait.
> `canFetch()` checks whether there are free slots, and returns true if so.
> It's recommended not to call `fetch()` untill `canFetch()` grants a green light.
> 
> Example:
> 
> ```ts
> if (!fcgi.canFetch())
> {	await fcgi.waitCanFetch();
> }
> await fcgi.fetch(...);
> ```



#### ⚙ waitCanFetch(): Promise\<`void`>



