# `class` ServerRequest `implements` [Conn](../interface.Conn/README.md)

[Documentation Index](../README.md)

```ts
import {ServerRequest} from "https://deno.land/x/fcgi@v2.1.2/mod.ts"
```

## This class has

- [constructor](#-constructorconn-conn-onerror-error-error--void-buffer-uint8array--null-structuredparams-boolean-maxconns-number-maxnamelength-number-maxvaluelength-number-maxfilesize-number)
- [destructor](#-symboldispose-void)
- 21 properties:
[localAddr](#-readonly-localaddr-denoaddr),
[remoteAddr](#-readonly-remoteaddr-denoaddr),
[rid](#-readonly-rid-number),
[url](#-url-string),
[method](#-method-string),
[proto](#-proto-string),
[protoMinor](#-protominor-number),
[protoMajor](#-protomajor-number),
[params](#-params-mapstring-string),
[headers](#-headers-headers),
[get](#-get-get),
[post](#-post-post),
[cookies](#-cookies-cookies),
[readable](#-readonly-readable-rdstream),
[writable](#-readonly-writable-wrstream),
[responseStatus](#-responsestatus-number),
[responseHeaders](#-responseheaders-headers),
[headersSent](#-headerssent-boolean),
[terminated](#-get-terminated-boolean),
[responded](#-get-responded-boolean),
[conn](#-conn-conn)
- 9 methods:
[ref](#-ref-void),
[unref](#-unref-void),
[read](#-readbuffer-uint8array-promisenumber),
[write](#-writebuffer-uint8array-promisenumber),
[logError](#-logerrormessage-string-void),
[respond](#-respondresponse-serverresponse-promisevoid),
[close](#-close-void),
[closeWrite](#-closewrite-promisevoid),
[complete](#-complete-promiseserverrequest)
- [deprecated symbol](#-deprecated-isterminated-boolean)


#### 🔧 `constructor`(conn: [Conn](../interface.Conn/README.md), onerror: (error: Error) => `void`, buffer: Uint8Array | `null`, structuredParams: `boolean`, maxConns: `number`, maxNameLength: `number`, maxValueLength: `number`, maxFileSize: `number`)



#### 🔨 \[Symbol.dispose](): `void`



#### 📄 `readonly` localAddr: Deno.Addr

> The local address of the connection.



#### 📄 `readonly` remoteAddr: Deno.Addr

> The remote address of the connection.



#### 📄 `readonly` rid: `number`

> The resource ID of the connection.



#### 📄 url: `string`

> REQUEST_URI of the request, like '/path/index.html?a=1'



#### 📄 method: `string`

> Request method, like 'GET'



#### 📄 proto: `string`

> Request protocol, like 'HTTP/1.1' or 'HTTP/2'



#### 📄 protoMinor: `number`



#### 📄 protoMajor: `number`



#### 📄 params: Map\<`string`, `string`>

> Environment params sent from FastCGI frontend. This usually includes 'REQUEST_URI', 'SCRIPT_URI', 'SCRIPT_FILENAME', 'DOCUMENT_ROOT', can contain 'CONTEXT_DOCUMENT_ROOT' (if using Apache MultiViews), etc.



#### 📄 headers: Headers

> Request HTTP headers



#### 📄 get: [Get](../class.Get/README.md)

> Access POST body and uploaded files from here.



#### 📄 post: [Post](../class.Post/README.md)

> Access POST body and uploaded files from here.



#### 📄 cookies: [Cookies](../class.Cookies/README.md)

> Request cookies can be read from here, and modified. Setting or deleting a cookie sets corresponding HTTP headers.



#### 📄 `readonly` readable: [RdStream](../class.RdStream/README.md)

> Post body can be read from here.



#### 📄 `readonly` writable: [WrStream](../class.WrStream/README.md)

> Write request here.



#### 📄 responseStatus: `number`

> Set this at any time before calling respond() to be default response HTTP status code (like 200 or 404). However status provided to respond() overrides this. Leave 0 for default 200 status.



#### 📄 responseHeaders: Headers

> You can set response HTTP headers before calling respond(). Headers provided to respond() will override them. Header called "status" acts as default HTTP status code, if responseStatus is not set.



#### 📄 headersSent: `boolean`

> True if headers have been sent to client. They will be sent if you write some response data to `writable` of this request object.



#### 📄 `get` terminated(): `boolean`



#### 📄 `get` responded(): `boolean`

> Returns `true` after calling [respond()](../class.ServerRequest/README.md#-respondresponse-serverresponse-promisevoid).



#### 📄 conn: [Conn](../interface.Conn/README.md)



#### ⚙ ref(): `void`

> Make the connection block the event loop from finishing.
> 
> Note: the connection blocks the event loop from finishing by default.
> This method is only meaningful after `.unref()` is called.



#### ⚙ unref(): `void`

> Make the connection not block the event loop from finishing.



#### ⚙ read(buffer: Uint8Array): Promise\<`number`>

> Reads up to `p.byteLength` bytes into `p`. It resolves to the number of
> bytes read (`0` < `n` <= `p.byteLength`) and rejects if any error
> encountered. Even if `read()` resolves to `n` < `p.byteLength`, it may
> use all of `p` as scratch space during the call. If some data is
> available but not `p.byteLength` bytes, `read()` conventionally resolves
> to what is available instead of waiting for more.
> 
> When `read()` encounters end-of-file condition, it resolves to EOF
> (`null`).
> 
> When `read()` encounters an error, it rejects with an error.
> 
> Callers should always process the `n` > `0` bytes returned before
> considering the EOF (`null`). Doing so correctly handles I/O errors that
> happen after reading some bytes and also both of the allowed EOF
> behaviors.
> 
> Implementations should not retain a reference to `p`.
> 
> Use
> [`itereateReader`](https://deno.land/std/streams/iterate_reader.ts?s=iterateReader)
> from
> [`std/streams/iterate_reader.ts`](https://deno.land/std/streams/iterate_reader.ts)
> to turn a `Reader` into an `AsyncIterator`.



#### ⚙ write(buffer: Uint8Array): Promise\<`number`>

> Writes `p.byteLength` bytes from `p` to the underlying data stream. It
> resolves to the number of bytes written from `p` (`0` <= `n` <=
> `p.byteLength`) or reject with the error encountered that caused the
> write to stop early. `write()` must reject with a non-null error if
> would resolve to `n` < `p.byteLength`. `write()` must not modify the
> slice data, even temporarily.
> 
> This function is one of the lowest
> level APIs and most users should not work with this directly, but rather use
> [`writeAll()`](https://deno.land/std/streams/write_all.ts?s=writeAll) from
> [`std/streams/write_all.ts`](https://deno.land/std/streams/write_all.ts)
> instead.
> 
> Implementations should not retain a reference to `p`.



#### ⚙ logError(message: `string`): `void`

> Send error message to SAPI, that probably will be printed to error log file of FastCGI server.
> Call this before `respond()`.



#### ⚙ respond(response?: [ServerResponse](../interface.ServerResponse/README.md)): Promise\<`void`>



#### ⚙ close(): `void`

> Closes the resource, "freeing" the backing file/resource.



#### ⚙ closeWrite(): Promise\<`void`>

> Shuts down (`shutdown(2)`) the write side of the connection. Most
> callers should just use `close()`.



#### ⚙ complete(): Promise\<[ServerRequest](../class.ServerRequest/README.md)>



<div style="opacity:0.6">

#### ⚙ `deprecated` isTerminated(): `boolean`

> `deprecated`
> 
> Use [terminated](../class.ServerRequest/README.md#-get-terminated-boolean) instead.



</div>

