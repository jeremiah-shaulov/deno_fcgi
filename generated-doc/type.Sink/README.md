# `type` Sink

[Documentation Index](../README.md)

## This type has

- 7 methods:
[start](#-start-void--promiselikevoid),
[write](#-writechunk-uint8array-number--promiselikenumber),
[flush](#-flush-void--promiselikevoid),
[close](#-close-void--promiselikevoid),
[abort](#-abortreason-unknown-void--promiselikevoid),
[catch](#-catchreason-unknown-void--promiselikevoid),
[finally](#-finally-void--promiselikevoid)


#### ⚙ start?(): `void` | PromiseLike\<`void`>

> This callback is called immediately during `WrStream` object creation.
> When it's promise resolves, i start to call `write()` as response to `writer.write()`.
> Only one call is active at each moment, and next calls wait for previous calls to complete.
> 
> At the end one of `close()`, `abort(reason)` or `catch(error)` is called.
> - `close()` if caller called `writer.close()` to terminate the stream.
> - `abort()` if caller called `wrStream.abort(reason)` or `writer.abort(reason)`.
> - `catch()` if `write()` thrown exception or returned a rejected promise.
> 
> And the very last step is to call `finally()`, and if it thrown also to call `catch()` (again?).



#### ⚙ write(chunk: Uint8Array): `number` | PromiseLike\<`number`>

> WrStream calls this callback to ask it to write a chunk of data to the destination that it's managing.
> The callback can process the writing completely or partially, and it must return number of bytes processed
> (how many bytes from the beginning of the chunk are written).
> If it processed only a part, the rest of the chunk, and probably additional bytes,
> will be passed to the next call to `write()`.
> This callback must not return 0.



#### ⚙ flush?(): `void` | PromiseLike\<`void`>

> This method is called as response to `writer.flush()`.
> If this writer implements buffering, this callback is expected to send the buffer contents.



#### ⚙ close?(): `void` | PromiseLike\<`void`>

> This method is called as response to `writer.close()`.
> After that, no more callbacks are called (except `catch()` and/or `finally()`).



#### ⚙ abort?(reason: `unknown`): `void` | PromiseLike\<`void`>

> This method is called as response to `wrStream.abort(reason)` or `writer.abort(reason)`.
> After that, no more callbacks are called (except `catch()` and/or `finally()`).
> This callback can be called in the middle of `write()` (before it's promise fulfilled), to let
> you interrupt the writing operation.



#### ⚙ catch?(reason: `unknown`): `void` | PromiseLike\<`void`>

> This method is called when [Sink.write](../type.Sink/README.md#-writechunk-uint8array-number--promiselikenumber) thrown exception or returned a rejected promise.
> After that, no more callbacks are called.
> Exceptions in `catch()` are silently ignored.



#### ⚙ finally?(): `void` | PromiseLike\<`void`>

> Is called when the stream is finished in either way.



