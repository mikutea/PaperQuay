These unmodified public-domain SQLite 3.51.2 API headers come from Node v24.14.0:

- https://raw.githubusercontent.com/nodejs/node/v24.14.0/deps/sqlite/sqlite3.h
  SHA-256: `6c8b9f648f36c84b0eeb3239b1e6f32b459d2c859d905ba5d59153c3569e6562`
- https://raw.githubusercontent.com/nodejs/node/v24.14.0/deps/sqlite/sqlite3ext.h
  SHA-256: `ea81fb7bd05882e0e0b92c4d60f677b205f7f1fbf085f218b12f0b5b3f0b9e48`

The addon links to no second SQLite implementation. `loadExtension()` provides
the host's public API table. Required VFS version, system-call hooks and VFS
registration are checked at runtime; unsupported or replaced hooks fail closed.
No Node internals, SQLite private structures or offsets are accessed.
