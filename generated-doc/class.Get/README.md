# `class` Get `extends` [StructuredMap](../class.StructuredMap/README.md)

[Documentation Index](../README.md)

## This class has

- [constructor](#-constructorquery_string-string-structuredparams-booleanfalse)
- 3 properties:
[query\_string](#-query_string-string),
[structuredParams](#-structuredparams-boolean),
[size](#-override-get-size-number)
- 11 methods:
[setQueryString](#-setquerystringquery_string-string-void),
[clear](#-override-clear-void),
[has](#-override-hasname-string-boolean),
[get](#-override-getname-string-pathnode),
[set](#-override-setname-string-value-string-this),
[delete](#-override-deletename-string-boolean),
[entries](#-override-entries-mapiteratorstring-pathnode),
[keys](#-override-keys-mapiteratorstring),
[values](#-override-values-mapiteratorpathnode),
[forEach](#-override-foreachcallback-value-pathnode-key-string-map-mapstring-pathnode--void-thisarg-any-void),
[\[Symbol.iterator\]](#-override-symboliterator-mapiteratorstring-pathnode)
- base class


#### 🔧 `constructor`(query\_string: `string`="", structuredParams: `boolean`=false)



#### 📄 query\_string: `string`



#### 📄 structuredParams: `boolean`



#### 📄 `override` `get` size(): `number`



#### ⚙ setQueryString(query\_string: `string`): `void`



#### ⚙ `override` clear(): `void`



#### ⚙ `override` has(name: `string`): `boolean`



#### ⚙ `override` get(name: `string`): PathNode

> Returns a specified element from the Map object. If the value that is associated to the provided key is an object, then you will get a reference to that object and any change made to that object will effectively modify it inside the Map.



#### ⚙ `override` set(name: `string`, value: `string`): `this`

> Adds a new element with a specified key and value to the Map. If an element with the same key already exists, the element will be updated.



#### ⚙ `override` delete(name: `string`): `boolean`



#### ⚙ `override` entries(): MapIterator\<\[`string`, PathNode]>

> Returns an iterable of key, value pairs for every entry in the map.



#### ⚙ `override` keys(): MapIterator\<`string`>

> Returns an iterable of keys in the map



#### ⚙ `override` values(): MapIterator\<PathNode>

> Returns an iterable of values in the map



#### ⚙ `override` forEach(callback: (value: [PathNode](../type.PathNode/README.md), key: `string`, map: Map\<`string`, [PathNode](../type.PathNode/README.md)>) => `void`, thisArg?: [Any](../private.type.Any.2/README.md)): `void`

> Executes a provided function once per each key/value pair in the Map, in insertion order.



#### ⚙ `override` \[Symbol.iterator](): MapIterator\<\[`string`, PathNode]>



