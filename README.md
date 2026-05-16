# Registro del bebe

App web para registrar eventos de un recien nacido entre varias personas.

## Uso

```bash
node --no-warnings server.js
```

Despues abre:

```text
http://localhost:3000
```

El servidor escucha en `0.0.0.0`, asi que otros dispositivos de la misma red pueden entrar usando la IP de la computadora que lo esta ejecutando:

```text
http://IP-DE-LA-COMPUTADORA:3000
```

Los datos se guardan de forma central en SQLite:

```text
data/baby-tracker.sqlite
```

## Notas

- No usa `localStorage` para los registros.
- No requiere instalar paquetes.
- Si existia `data/baby-tracker.json`, el servidor intenta migrarlo a SQLite al iniciar con una base vacia.
- Si se publica fuera de una red privada, conviene agregar autenticacion antes de usarlo con datos reales.
