# `interface` ServerResponse

[Documentation Index](../README.md)

```ts
import {ServerResponse} from "https://deno.land/x/fcgi@v2.0.8/mod.ts"
```

## This interface has

- 5 properties:
[status](#-status-number),
[headers](#-headers-headers),
[setCookies](#-setcookies-setcookies),
[body](#-body-uint8array--readablestreamuint8array--reader--string),
[trailers](#-trailers---promiseheaders--headers)


#### 📄 status?: `number`



#### 📄 headers?: Headers



#### 📄 setCookies?: [SetCookies](../class.SetCookies/README.md)



#### 📄 body?: Uint8Array | ReadableStream\<Uint8Array> | [Reader](../interface.Reader/README.md) | `string`



#### 📄 trailers?: () => Promise\<Headers> | Headers



