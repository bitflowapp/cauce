// Contrato entre este frontend y el esquema de la base. Si la base declara un
// esquema anterior (migraciones sin aplicar), la aplicación no opera y lo dice.
// 20261024100000: taxonomía de rubros y capacidades por comercio
// (docs/CAUCE-MARKETPLACE-MULTIRRUBRO-20261024.md, fase 1). Excige también
// todos los contratos anteriores, porque cada migración los conserva.
export const REQUIRED_SCHEMA = 20261024100000;
