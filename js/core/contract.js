// Contrato entre este frontend y el esquema de la base. Si la base declara un
// esquema anterior (migraciones sin aplicar), la aplicación no opera y lo dice.
// 20261025120000: condición nuevo/usado en productos (MiFav).
// 20261026120000: permisos de la columna condición para el alta de productos.
// 20261026130000: moderación de productos y su historial de revisión.
// Exige también todos los contratos anteriores, porque cada migración los conserva.
export const REQUIRED_SCHEMA = 20261026130000;
