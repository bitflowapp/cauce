import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('ausencia de afirmaciones infladas o no demostradas en el copy de la aplicación', async () => {
  const appJs = await readFile(resolve(root, 'js/app.js'), 'utf8');
  const indexHtml = await readFile(resolve(root, 'index.html'), 'utf8');
  const content = appJs + '\n' + indexHtml;

  const forbiddenExpressions = [
    '25% y 35%',
    '25% de comisión',
    '35% de comisión',
    '100% del valor',
    '100% de los ingresos',
    'comisiones extractivas',
    'comisiones confiscatorias',
    'confiscatorias',
    'servidores extranjeros',
    'soberanía de datos',
    'soberanía tecnológica',
    'elimina comisiones',
    'comisiones abusivas',
    'alianza municipal',
    'plataforma municipal',
    'programa municipal',
    'junto al municipio',
    'Fuga de valor local',
    'Exclusión de Pequeños Comercios',
    'algoritmos estándar',
    '500+',
    'satisfacción Alto',
    'queda íntegramente en la comunidad',
    'dinamiza el empleo',
    'PILOTO 90 DÍAS',
    '90 días',
    'carlos morales',
    'móvil 04',
    'aa 842 cd',
    'móviles habilitados',
    'chofer habilitado',
    'transporte habilitado',
    'infraestructura pública',
    'infraestructura comunitaria',
    'homologación',
    'homologado',
    'sin intermediarios',
    'comisiones desmedidas',
    'predatorias',
    'tarifas dinámicas',
    'comisiones bancarias extranjeras',
  ];

  for (const expr of forbiddenExpressions) {
    const found = content.toLowerCase().includes(expr.toLowerCase());
    assert.equal(
      found,
      false,
      `Expresión no defendible o inflada encontrada en el copy: "${expr}"`
    );
  }
});

test('presencia de tono institucional propositivo y constructivo en la presentación', async () => {
  const appJs = await readFile(resolve(root, 'js/app.js'), 'utf8');

  const requiredInstitutionalSections = [
    'PROPUESTA DE INFRAESTRUCTURA DIGITAL COMPARTIDA',
    'PROPUESTA DE PILOTO',
    'IMPLEMENTACIÓN POR ETAPAS',
    'Canales digitales fragmentados',
    'Barreras de digitalización',
    'Una experiencia pensada para la localidad',
    'CAUCE como Infraestructura Digital Compartida',
    'Un Modelo Adaptable a la Realidad Local',
    'Etapa 1',
    'Etapa 2',
    'Etapa 3',
    'Etapa 4',
    'Etapa 5',
    'Los tiempos y alcance se definen con los actores participantes',
    'COMERCIOS PARTICIPANTES',
    'PEDIDOS PROCESADOS',
    'TIEMPOS DE ENTREGA',
    'EXPERIENCIA DE USO',
    'A definir con el piloto',
    'Indicador a medir',
    'acompañamiento institucional',
  ];

  for (const phrase of requiredInstitutionalSections) {
    assert.equal(
      appJs.includes(phrase),
      true,
      `Falta frase institucional clave requerida: "${phrase}"`
    );
  }
});
