# `interface` Listener `extends` AsyncIterable\<[Conn](../interface.Conn/README.md)>

[Documentation Index](../README.md)

This interface matches `Deno.Listener`, but will not change in future versions of deno.
If `Deno.Listener` will change i'll update this interface, and correct the corresponding code in this library.

## This interface has

- 2 properties:
[addr](#-readonly-addr-denoaddr),
[rid](#-readonly-rid-number)
- 3 methods:
[accept](#-accept-promiseconn),
[close](#-close-void),
[\[Symbol.asyncIterator\]](#-symbolasynciterator-asynciterableiteratorconn-any-any)
- base type


#### 📄 `readonly` addr: Deno.Addr

> Return the address of the `Listener`.



#### 📄 `readonly` rid?: `number`

> Return the rid of the `Listener`.



#### ⚙ accept(): Promise\<[Conn](../interface.Conn/README.md)>

> Waits for and resolves to the next connection to the `Listener`.



#### ⚙ close(): `void`

> Close closes the listener. Any pending accept promises will be rejected with errors.



#### ⚙ \[Symbol.asyncIterator](): AsyncIterableIterator\<[Conn](../interface.Conn/README.md), `any`, `any`>



