# `interface` RequestOptions

[Documentation Index](../README.md)

```ts
import {RequestOptions} from "https://deno.land/x/fcgi@v2.1.2/mod.ts"
```

## This interface has

- 8 properties:
[addr](#-addr-fcgiaddr--conn),
[scriptFilename](#-scriptfilename-string),
[params](#-params-mapstring-string),
[connectTimeout](#-connecttimeout-number),
[timeout](#-timeout-number),
[keepAliveTimeout](#-keepalivetimeout-number),
[keepAliveMax](#-keepalivemax-number),
[onLogError](#-onlogerror-error-string--void)


#### 📄 addr: [FcgiAddr](../type.FcgiAddr/README.md) | [Conn](../interface.Conn/README.md)

> FastCGI service address. For example address of PHP-FPM service (what appears in "listen" directive in PHP-FPM pool configuration file).



#### 📄 scriptFilename?: `string`

> `scriptFilename` can be specified here, or in `params` under 'SCRIPT_FILENAME' key. Note that if sending to PHP-FPM, the response will be empty unless you provide this parameter. This parameter must contain PHP script file name.



#### 📄 params?: Map\<`string`, `string`>

> Additional parameters to send to FastCGI server. If sending to PHP, they will be found in $_SERVER. If `params` object is given, it will be modified - `scriptFilename` and parameters inferred from request URL will be added to it.



#### 📄 connectTimeout?: `number`

> Milliseconds. If socket connection takes longer, it will be forced to close.



#### 📄 timeout?: `number`

> Milliseconds. Connection will be forced to close after this timeout elapses.



#### 📄 keepAliveTimeout?: `number`

> Milliseconds. Idle connection will be closed if not used for this period of time.



#### 📄 keepAliveMax?: `number`

> How many times to reuse this connection.



#### 📄 onLogError?: (error: `string`) => `void`

> Handler for errors logged from the requested service (messages printed to stderr).



