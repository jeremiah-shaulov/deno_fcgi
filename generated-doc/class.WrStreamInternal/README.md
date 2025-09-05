# `class` WrStreamInternal `extends` WritableStream\<Uint8Array>

[Documentation Index](../README.md)

## This class has

- [constructor](#-constructorsink-sinkinternal)
- 3 properties:
[locked](#-override-get-locked-boolean),
[isClosed](#-get-isclosed-boolean),
[closed](#-get-closed-promiseundefined)
- 6 methods:
[getWriter](#-override-getwriter-writablestreamdefaultwriteruint8arrayarraybufferlike--writer),
[getWriterWhenReady](#-getwriterwhenready-promisewritablestreamdefaultwriteruint8arrayarraybufferlike--writer),
[abort](#-override-abortreason-unknown-promisevoid),
[close](#-override-close-promisevoid),
[write](#-writechunk-uint8array--string-promisevoid),
[flush](#-flush-promisevoid)
- [deprecated symbol](#-deprecated-writewhenreadychunk-uint8array--string-promisevoid)
- base class


#### 🔧 `constructor`(sink: [SinkInternal](../private.type.SinkInternal/README.md))



#### 📄 `override` `get` locked(): `boolean`

> When somebody wants to start writing to this stream, he calls `wrStream.getWriter()`, and after that call the stream becomes locked.
> Future calls to `wrStream.getWriter()` will throw error till the writer is released (`writer.releaseLock()`).
> 
> Other operations that write to the stream (like `wrStream.write()`) also lock it (internally they get writer, and release it later).



#### 📄 `get` isClosed(): `boolean`



#### 📄 `get` closed(): Promise\<`undefined`>



#### ⚙ `override` getWriter(): WritableStreamDefaultWriter\<Uint8Array\<ArrayBufferLike>> \& Writer

> Returns object that allows to write data to the stream.
> The stream becomes locked till this writer is released by calling `writer.releaseLock()` or `writer[Symbol.dispose]()`.
> 
> If the stream is already locked, this method throws error.



#### ⚙ getWriterWhenReady(): Promise\<WritableStreamDefaultWriter\<Uint8Array\<ArrayBufferLike>> \& Writer>

> Like `wrStream.getWriter()`, but waits for the stream to become unlocked before returning the writer (and so locking it again).



#### ⚙ `override` abort(reason?: `unknown`): Promise\<`void`>

> Interrupt current writing operation (reject the promise that `writer.write()` returned, if any),
> and set the stream to error state.
> This leads to calling `sink.abort(reason)`, even if current `sink.write()` didn't finish.
> `sink.abort()` is expected to interrupt or complete all the current operations,
> and finalize the sink, as no more callbacks will be called.
> 
> In contrast to `WritableStream.abort()`, this method works even if the stream is locked.



#### ⚙ `override` close(): Promise\<`void`>

> Calls `sink.close()`. After that no more callbacks will be called.
> If `close()` called again on already closed stream, nothing happens (no error is thrown).



#### ⚙ write(chunk?: Uint8Array | `string`): Promise\<`void`>

> Waits for the stream to be unlocked, gets writer (locks the stream),
> writes the chunk, and then releases the writer (unlocks the stream).
> This is the same as doing:
> ```ts
> {	using writer = await wrStream.getWriterWhenReady();
> 	await writer.write(chunk);
> }
> ```



#### ⚙ flush(): Promise\<`void`>

> Waits for the stream to be unlocked, gets writer (locks the stream),
> flushes the stream, and then releases the writer (unlocks the stream).
> This is the same as doing:
> ```ts
> {	using writer = await wrStream.getWriterWhenReady();
> 	await writer.flush();
> }
> ```



<div style="opacity:0.6">

#### ⚙ `deprecated` writeWhenReady(chunk: Uint8Array | `string`): Promise\<`void`>

> Use `write()` instead.



</div>

