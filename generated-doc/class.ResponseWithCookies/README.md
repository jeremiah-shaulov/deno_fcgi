# `class` ResponseWithCookies `extends` Response

[Documentation Index](../README.md)

```ts
import {ResponseWithCookies} from "https://deno.land/x/fcgi@v2.1.2/mod.ts"
```

## This class has

- [constructor](#-constructorbody-rdstream--null-init-responseinit-cookies-setcookiesnew-setcookies)
- 3 properties:
[body](#-override-body-rdstream--null),
[cookies](#-cookies-setcookies),
[charset](#-get-charset-string)
- 2 methods:
[text](#-override-text-promisestring),
[uint8Array](#-uint8array-promiseuint8arrayarraybufferlike)
- base class


#### 🔧 `constructor`(body: [RdStream](../class.RdStream/README.md) | `null`, init?: ResponseInit, cookies: [SetCookies](../class.SetCookies/README.md)=new SetCookies)



#### 📄 `override` body: [RdStream](../class.RdStream/README.md) | `null`

> A simple getter used to expose a `ReadableStream` of the body contents.



#### 📄 cookies: [SetCookies](../class.SetCookies/README.md)



#### 📄 `get` charset(): `string`



#### ⚙ `override` text(): Promise\<`string`>

> Takes a `Response` stream and reads it to completion. It returns a promise
> that resolves with a `USVString` (text).



#### ⚙ uint8Array(): Promise\<Uint8Array\<ArrayBufferLike>>



