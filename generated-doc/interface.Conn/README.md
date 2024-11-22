# `interface` Conn `extends` [Reader](../interface.Reader/README.md), [Writer](../interface.Writer/README.md), [Closer](../private.interface.Closer/README.md), Disposable

[Documentation Index](../README.md)

This interface matches `Deno.Conn`, but will not change in future versions of deno.
If `Deno.Conn` will change i'll update this interface, and correct the corresponding code in this library.

## This interface has

- 4 properties:
[localAddr](#-readonly-localaddr-denoaddr),
[remoteAddr](#-readonly-remoteaddr-denoaddr),
[readable](#-readonly-readable-readablestreamuint8array),
[writable](#-readonly-writable-writablestreamuint8array)
- 3 methods:
[closeWrite](#-closewrite-promisevoid),
[ref](#-ref-void),
[unref](#-unref-void)
- [deprecated symbol](#-deprecated-readonly-rid-number)
- base types


#### 📄 `readonly` localAddr: Deno.Addr

> The local address of the connection.



#### 📄 `readonly` remoteAddr: Deno.Addr

> The remote address of the connection.



#### 📄 `readonly` readable: ReadableStream\<Uint8Array>



#### 📄 `readonly` writable: WritableStream\<Uint8Array>



#### ⚙ closeWrite(): Promise\<`void`>

> Shuts down (`shutdown(2)`) the write side of the connection. Most
> callers should just use `close()`.



#### ⚙ ref(): `void`

> Make the connection block the event loop from finishing.
> 
> Note: the connection blocks the event loop from finishing by default.
> This method is only meaningful after `.unref()` is called.



#### ⚙ unref(): `void`

> Make the connection not block the event loop from finishing.



<div style="opacity:0.6">

#### 📄 `deprecated` `readonly` rid?: `number`

> The resource ID of the connection.
> 
> `deprecated`
> 
> This will be removed in Deno 2.0. See the
> [ Deno 1.x to 2.x Migration Guide](https://docs.deno.com/runtime/manual/advanced/migrate_deprecations%20)for migration instructions.



</div>

