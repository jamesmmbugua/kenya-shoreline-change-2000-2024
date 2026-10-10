/*
Export ONE clean, atomic per-scene metadata table directly from GEE -
covering timestamp, cloud cover, footprint centroid, and registration
accuracy in a single pass, with a real canonical scene identifier
(LANDSAT_PRODUCT_ID) pulled straight from each image's own metadata.

WHY THIS REPLACES THE TWO EARLIER SEPARATE EXPORTS:
compiled_scene_metadata_timestamp_2000_2024.csv and
sensor_scene_metadata_2000_2024.csv were two different exports, generated
at different points, using two different (incompatible) identifiers for
the same scenes - one the full USGS product ID, one GEE's own
merge-prefixed system:index. Reconciling them after the fact required
parsing path/row/date back out of both and matching on that. This script
avoids the problem at the source: every field comes from the SAME image,
in the SAME export pass, tagged with the SAME real identifier
(LANDSAT_PRODUCT_ID), so there is nothing to merge or doubt afterward.

DESIGNED TO BE CONTRIBUTED BACK: the harmonizeL57/harmonizeL89/
getYearCollection functions below are identical to the main script's, so
the metadata-building logic (inside the per-year loop, before the merge)
can be lifted into the main script directly. This version accumulates all
years into one FeatureCollection and exports it as a single task - lighter
than the per-year Sensor_Log export because it never touches Otsu
thresholding, compositing, or reduceToVectors, just per-image metadata
properties and a cheap centroid.

REQUIREMENT: draw your AOI polygon first, same as the main script, so the
`AOI` Import exists.
*/

var geometry = AOI;

// ============================================================
// Landsat 9 usage
// ============================================================
// Included by default here, matching the main script's actual collection
// logic AND the authoritative per-year sensor log, which shows real,
// nonzero l9_count for 2021-2024 (14, 159, 166, 168 scenes). An earlier
// version of this export defaulted to excluding L9 based on a statement
// that turned out to conflict with that log - this has been reverted to
// match the evidence. If you still intend to exclude L9 from the final
// manuscript results, set this to false, but the discrepancy between the
// script, the log, and the manuscript needs to be resolved either way,
// not just picked around.
var includeLandsat9 = true;

// ============================================================
// Band harmonization (unchanged from the main script)
// ============================================================

function harmonizeL57(image) {
  var qaMask = image.select('QA_PIXEL')
    .bitwiseAnd(parseInt('11111', 2)).eq(0);
  var saturationMask = image.select('QA_RADSAT').eq(0);

  var opticalBands = image.select('SR_B.')
    .multiply(0.0000275).add(-0.2);
  var thermalBand = image.select('ST_B6')
    .multiply(0.00341802).add(149.0);

  image = image.addBands(opticalBands, null, true)
    .addBands(thermalBand, null, true)
    .updateMask(qaMask)
    .updateMask(saturationMask);

  return image.select(
    ['SR_B1', 'SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B7'],
    ['blue',  'green', 'red',   'nir',   'swir1', 'swir2']
  ).copyProperties(image, [
    'system:time_start', 'LANDSAT_PRODUCT_ID', 'CLOUD_COVER',
    'WRS_PATH', 'WRS_ROW', 'GEOMETRIC_RMSE_MODEL',
    'GEOMETRIC_RMSE_MODEL_X', 'GEOMETRIC_RMSE_MODEL_Y'
  ]);
}

function harmonizeL89(image) {
  var qaMask = image.select('QA_PIXEL')
    .bitwiseAnd(parseInt('11111', 2)).eq(0);
  var saturationMask = image.select('QA_RADSAT').eq(0);

  var opticalBands = image.select('SR_B.')
    .multiply(0.0000275).add(-0.2);
  var thermalBand = image.select('ST_B10')
    .multiply(0.00341802).add(149.0);

  image = image.addBands(opticalBands, null, true)
    .addBands(thermalBand, null, true)
    .updateMask(qaMask)
    .updateMask(saturationMask);

  return image.select(
    ['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7'],
    ['blue',  'green', 'red',   'nir',   'swir1', 'swir2']
  ).copyProperties(image, [
    'system:time_start', 'LANDSAT_PRODUCT_ID', 'CLOUD_COVER',
    'WRS_PATH', 'WRS_ROW', 'GEOMETRIC_RMSE_MODEL',
    'GEOMETRIC_RMSE_MODEL_X', 'GEOMETRIC_RMSE_MODEL_Y'
  ]);
}

// NOTE: copyProperties() above explicitly lists every metadata field this
// script needs, because the original main script's copyProperties() call
// only preserved 'system:time_start' - band harmonization otherwise drops
// everything else on the floor. If you fold this into the main script,
// either update its harmonizeL57/harmonizeL89 to carry these fields too
// (recommended, since then any future export can use them), or keep this
// script's copies of the functions separate as done here.

// ============================================================
// Per-year collection builder (identical sensor-priority logic to the
// main script)
// ============================================================

function getYearCollection(year) {
  var startDate = ee.Date.fromYMD(year, 1, 1);
  var endDate = startDate.advance(1, 'year');

  var l5 = ee.ImageCollection('LANDSAT/LT05/C02/T1_L2')
    .filterDate(startDate, endDate)
    .filterBounds(geometry)
    .map(harmonizeL57)
    .map(function(img) { return img.set('sensor', 'L5'); });

  var l7 = ee.ImageCollection('LANDSAT/LE07/C02/T1_L2')
    .filterDate(startDate, endDate)
    .filterBounds(geometry)
    .map(harmonizeL57)
    .map(function(img) { return img.set('sensor', 'L7'); });

  var l8 = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
    .filterDate(startDate, endDate)
    .filterBounds(geometry)
    .map(harmonizeL89)
    .map(function(img) { return img.set('sensor', 'L8'); });

  var merged;
  if (year <= 2011) {
    merged = l5.merge(l7);
  } else if (year === 2012) {
    merged = l7;
  } else {
    merged = l8.merge(l7);
    if (includeLandsat9) {
      var l9 = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2')
        .filterDate(startDate, endDate)
        .filterBounds(geometry)
        .map(harmonizeL89)
        .map(function(img) { return img.set('sensor', 'L9'); });
      merged = merged.merge(l9);
    }
  }
  return merged;
}

// ============================================================
// One-time diagnostic: confirm the metadata fields actually exist on your
// AOI/collections before trusting the full export. Un-comment and run
// this block once by itself first.
// ============================================================

// var sample = ee.Image(getYearCollection(2015).first());
// print('Sample image property names:', sample.propertyNames());
// print('Sample LANDSAT_PRODUCT_ID:', sample.get('LANDSAT_PRODUCT_ID'));
// print('Sample GEOMETRIC_RMSE_MODEL:', sample.get('GEOMETRIC_RMSE_MODEL'));
// print('Sample CLOUD_COVER:', sample.get('CLOUD_COVER'));
// print('Sample WRS_PATH / WRS_ROW:', sample.get('WRS_PATH'), sample.get('WRS_ROW'));

// ============================================================
// Batch config and export
// ============================================================
// Combined into a single export across the full range, rather than one
// task per year. This is safe here (unlike the earlier Sensor_Log export,
// which failed combined) because nothing in this script touches the heavy
// per-year computation graph - no Otsu thresholding, no compositing, no
// reduceToVectors. It's just per-image metadata properties and a cheap
// centroid, accumulated via .merge() (the corrected pattern - see the
// note in export_scene_metadata.js about why naive Array.concat() with
// ee.List objects breaks this).

var batchStartYear = 2000;   // <-- EDIT if you want a smaller range
var batchEndYear   = 2024;

var yearList = ee.List.sequence(batchStartYear, batchEndYear);
var sceneMetadata = ee.FeatureCollection([]);

yearList.getInfo().forEach(function(year) {
  var yearCollection = getYearCollection(year);

  var withMeta = yearCollection.map(function(img) {
    var centroid = img.geometry().centroid(1).coordinates();
    return ee.Feature(null, {
      year: year,
      sensor: img.get('sensor'),
      landsat_product_id: img.get('LANDSAT_PRODUCT_ID'),
      wrs_path: img.get('WRS_PATH'),
      wrs_row: img.get('WRS_ROW'),
      cloud_cover: img.get('CLOUD_COVER'),
      time_start_millis: img.get('system:time_start'),
      time_start_iso: ee.Date(img.get('system:time_start')).format('YYYY-MM-dd\'T\'HH:mm:ss'),
      centroid_lon: centroid.get(0),
      centroid_lat: centroid.get(1),
      geometric_rmse_model: img.get('GEOMETRIC_RMSE_MODEL'),
      geometric_rmse_model_x: img.get('GEOMETRIC_RMSE_MODEL_X'),
      geometric_rmse_model_y: img.get('GEOMETRIC_RMSE_MODEL_Y')
    });
  });

  sceneMetadata = sceneMetadata.merge(withMeta);
  print('Added year ' + year + ' to the combined export');
});

Export.table.toDrive({
  collection: sceneMetadata,
  description: 'Scene_Metadata_Full_' + batchStartYear + '_' + batchEndYear,
  folder: 'earthengine',
  fileNamePrefix: 'scene_metadata_full_' + batchStartYear + '_' + batchEndYear,
  fileFormat: 'CSV'
});

print('Queued ONE combined export task - check the Tasks tab.');

/*
After running: go to the Tasks tab and click Run on the single
Scene_Metadata_Full_<start>_<end> task.

If this does turn out to hit a memory or task-size limit on your account
(unlikely given how lightweight the per-scene computation is, but GEE's
limits aren't fully predictable from account to account), the fallback is
to split batchStartYear/batchEndYear into two or three ranges and run this
script once per range - still far fewer clicks than one task per year.

Output columns (one row per scene, ALL years in one file): year, sensor,
landsat_product_id, wrs_path, wrs_row, cloud_cover, time_start_millis,
time_start_iso, centroid_lon, centroid_lat, geometric_rmse_model,
geometric_rmse_model_x, geometric_rmse_model_y.

No concatenation step needed - this IS the master table. Skip
compile_scene_metadata_full.py entirely if this combined export succeeds;
that script is only needed as a fallback if you end up running this in
multiple batches after all.

TO CONTRIBUTE THIS BACK to Landsat_Coastline_Extraction.js: this combined
version is harder to drop cleanly into the main script's existing per-year
loop (which is structured for per-year exports). If contributing back,
either keep this as a separate script run independently once per project,
or restructure it to accumulate sceneMetadata as a variable declared
outside the main script's loop and export it once after the loop
completes, mirroring the pattern here rather than the per-year Sensor_Log
pattern.
*/
