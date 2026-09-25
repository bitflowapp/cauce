# Pedidos de operación

Cambiar `solicitud.json` y hacer commit dispara el workflow **Operación de
producción** (`.github/workflows/operacion.yml`) con los secretos del
repositorio. Cada pedido queda en el historial de git.

| Campo | Valores |
| --- | --- |
| `paso` | `estado`, `migrar`, `auth`, `correo`, `admin`, `backup`, `smoke-previo` (antes de publicar: build de producción contra el proyecto real), `smoke-publicado`, `limpiar-qa` |
| `aplicar` | `false` (sólo muestra qué haría) o `true` (escribe) |
| `confirmar` | para `aplicar: true`, el ref del proyecto: `ygqbcvxdrewcnzedfcyo` |
| `email` | paso `admin`: correo de la cuenta de administración |
| `invitar` | paso `admin`: invitar la cuenta si todavía no existe |
| `motivo` | texto libre para el historial (el workflow no lo usa) |

El workflow valida cada campo antes de usarlo; sin `aplicar` y `confirmar`,
ningún paso escribe. Lo mismo se puede pedir a mano desde Actions.
