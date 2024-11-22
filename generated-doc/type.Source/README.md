# `type` Source

[Documentation Index](../README.md)

## This type has

- 2 properties:
[autoAllocateChunkSize](#-autoallocatechunksize-number),
[autoAllocateMin](#-autoallocatemin-number)
- 6 methods:
[start](#-start-void--promiselikevoid),
[read](#-readview-uint8array-number--promiselikenumber),
[close](#-close-void--promiselikevoid),
[cancel](#-cancelreason-unknown-void--promiselikevoid),
[catch](#-catchreason-unknown-void--promiselikevoid),
[finally](#-finally-void--promiselikevoid)


#### 📄 autoAllocateChunkSize?: `number`

> When auto-allocating (reading in non-byob mode) will pass to [Source.read](../type.Source/README.md#-readview-uint8array-number--promiselikenumber) buffers of at most this size.
> If undefined or non-positive number, a predefined default value (like 32 KiB) is used.



#### 📄 autoAllocateMin?: `number`

> When auto-allocating (reading in non-byob mode) will not call `read()` with buffers smaller than this.
> First i'll allocate `autoAllocateChunkSize` bytes, and if `read()` callback fills in only a small part of them
> (so there're >= `autoAllocateMin` unused bytes in the buffer), i'll reuse that part of the buffer in next `read()` calls.



#### ⚙ start?(): `void` | PromiseLike\<`void`>

> This callback is called immediately during `RdStream` object creation.
> When it's promise resolves, i start to call `read()` to pull data as response to `reader.read()`.
> Only one call is active at each moment, and next calls wait for previous calls to complete.
> 
> At the end one of `close()`, `cancel(reason)` or `catch(error)` is called.
> - `close()` is called if `read()` returned EOF (`0` or `null`).
> - `cancel()` if caller called `rdStream.cancel(reason)` or `reader.cancel(reason)`.
> - `catch()` if `read()` thrown exception or returned a rejected promise.
> 
> And the very last step is to call `finally()`, and if it thrown also to call `catch()` (again?).



#### ⚙ read(view: Uint8Array): `number` | PromiseLike\<`number`>

> This method is called to pull data from input source to a Uint8Array object provied to it.
> The object provided is never empty.
> The function is expected to load available data to the view, and to return number of bytes loaded.
> On EOF it's expected to return `0` or `null`.
> This callback is called as response to user request for data, and it's never called before such request.



#### ⚙ close?(): `void` | PromiseLike\<`void`>

> This method is called when [Source.read](../type.Source/README.md#-readview-uint8array-number--promiselikenumber) returns `0` or `null` that indicate EOF.
> After that, no more callbacks are called (except `catch()` and/or `finally()`).
> If you use `Deno.Reader & Deno.Closer` as source, that source will be closed when read to the end without error.



#### ⚙ cancel?(reason: `unknown`): `void` | PromiseLike\<`void`>

> Is called as response to `rdStream.cancel()` or `reader.cancel()`.
> After that, no more callbacks are called (except `catch()` and/or `finally()`).
> If this callback is not set, the default behavior is to read and discard the stream to the end.
> This callback can be called in the middle of `read()` (before it's promise fulfilled), to let
> you interrupt the reading operation.



#### ⚙ catch?(reason: `unknown`): `void` | PromiseLike\<`void`>

> Is called when `start()`, `read()`, `close()` or `cancel()` thrown exception or returned a rejected promise.
> After that, no more callbacks are called.
> Exceptions in `catch()` are silently ignored.



#### ⚙ finally?(): `void` | PromiseLike\<`void`>

> Is called when the stream is finished in either way.



