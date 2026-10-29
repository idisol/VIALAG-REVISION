# RE-visión (VialAG) · versión V01

Página web para revisar planos con notas que siguen vivas entre versiones. Corre entera en el navegador: los planos no se suben a ningún servidor. Es HTML, CSS y JavaScript sin compilar: no necesita Node, base de datos ni servidor de aplicaciones.

## Archivos

```
index.html            estructura de la página y dibujos de la loica (SVG)
css/estilos.css       colores, tipografía y diseño
js/motor.js           lectura de PDF/DXF, dibujo, alineación y comparación
js/app.js             versiones, notas, revisión guardada e informes PDF/DXF
img/logo-vialag.png   logo del header
favicon.ico, img/favicon-32.png, img/favicon-192.png, img/apple-touch-icon.png
                      ícono de la pestaña del navegador (y del acceso directo en celular),
                      hechos desde img/icono-idisol.png (el original, 213 × 213 px)
audio/loica-canto.mp3 canto de la loica al tocarle la cabeza
.nojekyll             archivo vacío para GitHub Pages: publica los archivos tal como están
vendor/               librerías incluidas (no se cargan desde internet): pdf.js 3.11.174, dxf-parser,
                      jsPDF 2.5.1, JSZip 3.10.1; sus licencias en vendor/licencias/ y LICENCIAS-TERCEROS.txt
```

## Probarla en tu computador
Descomprime el ZIP y abre `index.html` con doble clic (Chrome, Edge, Firefox o Safari).

## Publicarla en GitHub (GitHub Pages)
La carpeta funciona tal cual en GitHub Pages: todas las rutas son relativas y no hay nada que compilar.

1. Crea un repositorio (por ejemplo `re-vision`) y sube **el contenido de esta carpeta** a la raíz: `index.html`, `css/`, `js/`, `img/`, `audio/`, `vendor/`, `favicon.ico`, `.nojekyll`, este README y las licencias. Desde la web de GitHub: *Add file → Upload files* y arrastra todo (incluidas las carpetas). Con git: `git add -A`, `git commit` y `git push`.
2. En el repositorio: *Settings → Pages → Build and deployment → Source: Deploy from a branch*, rama `main`, carpeta `/ (root)`, *Save*.
3. En uno o dos minutos queda en `https://<tu-usuario>.github.io/re-vision/`. Si en vez del contenido subes la carpeta entera, la dirección termina en `/re-vision/re-vision/`; funciona igual.
4. Para un dominio propio (por ejemplo `revision.vialag.com`): en *Settings → Pages → Custom domain* escribe el dominio y en los DNS de vialag.com crea un registro CNAME de `revision` hacia `<tu-usuario>.github.io`.

Para publicar una versión nueva, reemplaza los archivos por los del ZIP nuevo (mismos nombres) y vuelve a subirlos.

## Otros sitios
Sirve en cualquier hosting de archivos estáticos (Netlify Drop, el hosting de vialag.com, Cloudflare Pages, Wix Headless Drop). Fuera de claude.ai los informes PDF y DXF y la revisión guardada se descargan directo, sin abrir otra pestaña.

## Internet
Las librerías van incluidas en `vendor/`. Lo único que se pide a internet son las tipografías IBM Plex (Google Fonts). Sin conexión la página funciona igual y usa Arial.

## Seguridad
pdf.js 3.11.174 tiene una vulnerabilidad conocida (CVE-2024-4367) que permite ejecutar código al abrir un PDF preparado para eso. La página la evita con la mitigación oficial (`isEvalSupported: false` al abrir cada PDF, en `js/app.js`).

## Cómo se usa
1. Escribe Proyecto, Detalle, Creador y Revisor sobre sus líneas segmentadas (son los únicos campos que se editan a mano).
2. Elige el plano (PDF o DXF; el DWG se exporta antes a DXF) o arrástralo a la pantalla. Esa es la versión 1. Con el primer plano aparece la tarjeta blanca con las descargas y "Guardar revisión"; el cuadro con el % de cambios aparece cuando hay dos versiones a la vista.
3. "Agregar NOTA" (botón rojo al centro) y haz un rectángulo sobre el plano. Dentro de la nota: texto, botón "Grave", dibujo a mano en rojo o azul (la flecha hacia atrás borra el último trazo) y una imagen adjunta: el clip para elegirla o Ctrl+V para pegarla. La imagen queda como miniatura en la nota (al tocarla se agranda), no sobre el plano. "Guardar" la deja lista; "Cancelar" deja la nota como estaba. Una nota nueva se queda aunque no se le escriba nada, con el texto "Sin comentarios" (se borra solo con el basurero). El cuadro de Notas aparece con la primera nota.
4. "Ver INFORME" y "Descargar PDF" bajan el informe PDF directo, sin abrir otra pestaña. "Guardar revisión" baja un .zip con la revisión (.json) y los planos de cada versión; guárdalo en la carpeta compartida "estadística". Si dentro de claude.ai el .zip resulta demasiado grande, la app ofrece guardarlo sin los planos. "Descargar DXF" baja el DXF. Los botones de descarga son beige y pasan a negro con el mouse; lo descargado es lo que se le manda al dibujante.
5. Cuando llega la corrección: "Agregar plano". Lo que cambió se ve en rojo VialAG y las notas siguen en su lugar, con un aviso de si su zona cambió. En cada nota: "✓ Check" (la oculta; "Ver notas en check" las vuelve a mostrar) o el basurero para eliminarla.
6. Para seguir otro día: "Abrir una revisión guardada" (o arrastrar el .zip). Vuelven las notas y los planos, con la última versión encendida; las demás se prenden con su interruptor. Una revisión .json de versiones anteriores (sin planos) también se abre: después se cargan sus planos, que se reconocen por su huella aunque cambien de nombre.

## Versiones
- Máximo tres versiones activas. Al agregar una cuarta, la app ofrece quitar la más antigua; las notas se conservan.
- Cada versión muestra su número en un cuadro y debajo el interruptor para prenderla o apagarla. Se ven como máximo dos a la vez: la anterior en gris y la nueva encima, con lo que cambió en rojo. Con una sola prendida se ve ese plano solo. Con dos, las pestañas sobre el plano muestran cada versión sola: la anterior en #877a67 y la nueva en #c7bda8, como en el Comparador A·B.
- Para cambiar el orden, arrastra una versión arriba o abajo de otra. Los números siguen el orden nuevo; la primera es la referencia en gris. Las notas no se mueven del plano.
- El archivo de revisión guarda, sin mostrarlo, en qué versión va cada nota, cuándo se hizo check y la huella de cada plano. Esos archivos son la base para la estadística de errores más adelante.

## Informes
- PDF: hoja con el plano, sus notas y el % de cambio. Al tocar una nota del plano, el PDF salta a su ficha, y cada ficha tiene "Ver en el plano general" para volver. Las observaciones graves van en sus propias hojas, antes que las demás. Cada ficha lleva el recorte del plano con el dibujo, la imagen adjunta en grande al lado y si su zona cambió. Al final, la lista de notas en check.
- DXF (cuando la versión más nueva a la vista es DXF): en coordenadas de esa versión, encabezado con el título RE-VISIÓN en Arial Black subrayado (como en la página; en el PDF también), capas PLANO (una versión) o COINCIDE, ANTERIOR y CAMBIO (dos versiones), NOTAS, NOTAS_GRAVES, NOTAS_ROJO, NOTAS_AZUL y ENCABEZADO. La imagen adjunta va solo en el PDF.

## Colores
La versión de la página va chica en #c7bda8 arriba a la derecha del título RE-VISIÓN.
Todos los botones usan solo la paleta de la loica: negro puro, beige oscuro #61594b, beige intermedio #7e705b, beige claro #f2e8cd y rojo #ed4133. La página se ve igual aunque el equipo use tema oscuro.

## Criterios
- Alineación entre versiones: por los ejes (al menos dos en una dirección y uno en la otra), aunque la nueva venga en otra escala o corrida. Si no calza, "Alinear con dos puntos".
- Las notas se anclan a coordenadas del plano, así que siguen en su lugar aunque la versión nueva venga corrida.
- Una burbuja de eje o una marca de corte que solo se corrió sobre su línea (la línea coincide, con el mismo texto) queda en gris. Un eje que se movió de lado, uno nuevo o con otra letra sigue en rojo.
- Textos iguales con otra fuente no cuentan como cambio.
- Interruptores bajo Versiones, iguales a los del Comparador A·B: "Hatchs" y "Elementos de anotación", prendidos de partida. Apagado, eso no se dibuja, no se compara ni va al DXF. Anotación son los ejes y sus burbujas, las cotas, los textos, los niveles y las líneas y cabezas de corte o elevación: también las marcas de corte (y el quiebre de un corte escalonado), las etiquetas en rombo, las líneas guía, las flechas de pendiente y los niveles en triángulo o rombo. En DXF se reconocen por sus capas y bloques; en PDF por sus capas si las trae y, si no, por su forma alrededor de los textos. La alineación automática usa siempre los planos completos.
- "Hatchs" apagado quita también el hatch dibujado como líneas sueltas (como lo imprimen Revit y AutoCAD en PDF, o el hatch explotado de un DXF). Un relleno chico y compacto (un pilar) se compara siempre, venga con contorno o sin él.
- "Alinear con dos puntos" está a la derecha de "Versiones" cuando hay dos versiones a la vista. Con dos puntos en cada versión la escala sale siempre de los puntos (así calza un PDF con un DXF); "misma escala" solo redondea a 1 una escala casi 1 y permite alinear con un punto. Cada clic se pega a la esquina o cruce de líneas más cercano.
- La loica de la pantalla inicial canta al tocarle la cabeza. Su cartel alterna "Arrastra aquí el plano que quieres revisar", "Te estoy esperando, puedes partir por un solo plano..." y "Vamos, no seas tímido". Mientras carga o prepara una descarga, una loica roja se para sobre el aviso y la loica de fondo desaparece.
