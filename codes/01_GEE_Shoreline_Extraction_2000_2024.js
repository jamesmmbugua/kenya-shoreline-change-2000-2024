/*
Spatiotemporal Shoreline and Sea Level Dynamics along the Kenyan Coast (2000–2024): 
Patterns of Erosion, Accretion, and Spatial Autocorrelation
 
Adapted from:
  Automated Coastline Detection and Extraction using Google Earth Engine
  Code by Ujaval Gandhi, www.spatialthoughts.com (MIT License)
  Based on:
  1. Canny Edge detector and Otsu thresholding by Gennadii Donchyts
     http://www.mdpi.com/2072-4292/8/5/386
  2. Coastline Extraction Script by Dhritiraj Sengupta
     https://doi.org/10.1016/j.scitotenv.2020.139290

This compiled version combines three exports that were developed and
debugged separately over the course of the reviewer-response work, into
one script that produces all three per run:

  1. Coastline_<year>            - annual shoreline shapefile, per year
                                    (unchanged from the original script)
  2. Sensor_Log_<year>           - per-year sensor/threshold transparency
                                    record, including otsu_threshold and
                                    gap_filled (fixed to export per-year
                                    after the combined version hit a
                                    "User memory limit exceeded" failure)
  3. Scene_Metadata_Full_<range> - ONE combined table, one row per Landsat
                                    scene, across the full batch range:
                                    real product ID, cloud cover, path/row,
                                    centroid, geometric RMSE, plus
                                    gap_filled/l7_share_of_scenes computed
                                    cheaply per year. otsu_threshold is
                                    NOT in this table (see note at the
                                    scene metadata section below for why) -
                                    join Sensor_Log_<year> on year for that.

Modifications made for this study (carried over from the original script):
  1. Extended sensor coverage from Landsat 8 only to Landsat 5, 7, 8, and 9,
     via per-sensor band harmonization, to cover 2000 to 2024.
  2. Removed the HYCOM-based tidal image filtering step used in the source
     script. Annual composites here are simple annual medians. Positional
     uncertainty from tidal stage is instead handled downstream using a
     global tide model (EOT20) evaluated at each scene's exact acquisition
     time, per the revised manuscript Section 2.2.2.
  3. Added explicit handling of Landsat 7 SLC-off scan line gaps
     (post-May 2003): Landsat 5 is prioritized as the primary sensor for
     overlap years (2000-2011) to minimize reliance on gap-affected L7
     scenes, and a post-composite focal mean gap fill is applied for
     years that rely primarily on L7 (2003-2012), with 2012 being the
     single-sensor gap year between Landsat 5 and Landsat 8.
  4. Wrapped extraction in a per-year loop across the full study period,
     producing one shoreline vector and one metadata record (sensor(s)
     used, scene count, composite window) per year to support a
     supplementary transparency table.

Additional modifications made:
  5. Sensor_Log export split to one task per year instead of one combined
     task for the whole batch - the combined version failed with a
     memory-limit error because otsu_threshold requires the full
     Otsu/compositing computation graph, which is too heavy to hold for
     multiple years in a single export.
  6. harmonizeL57/harmonizeL89 copyProperties() calls extended to carry
     LANDSAT_PRODUCT_ID, CLOUD_COVER, WRS_PATH, WRS_ROW,
     GEOMETRIC_RMSE_MODEL(+X/Y) through band harmonization - the original
     versions only preserved system:time_start, which silently dropped
     every other metadata field needed for the scene metadata export.
  7. Added the Scene_Metadata_Full combined export, accumulated across all
     years via ee.FeatureCollection.merge() (NOT client-side
     Array.concat() with ee.List objects, which silently produces a
     nested List<List<Feature>> and fails export - see the note at that
     section). This export is safe to combine across the whole batch
     range in one task because it never touches Otsu thresholding,
     compositing, or reduceToVectors - just per-image metadata properties
     and a cheap centroid.

This work is licensed under the terms of the MIT license.
For a copy, see https://opensource.org/licenses/MIT
*/

// ============================================================
// CONFIGURATION
// ============================================================

// Full study period, kept for reference and for the manuscript text.
var studyStartYear = 2000;
var studyEndYear = 2024;

// Batch range actually run in this execution. Change these two values
// and re-run the script for each batch, rather than trying to queue
// all 25 years of exports in one session.
// Suggested batches:
//   Batch 1: 2000-2008
//   Batch 2: 2009-2016
//   Batch 3: 2017-2024
// NOTE: the Scene_Metadata_Full export at the end is lightweight and
// does not need to be batched the way Coastline_<year>/Sensor_Log_<year>
// do - if you only need the metadata table (not the shapefiles), you can
// set batchStartYear/batchEndYear to the full 2000-2024 range and only
// the metadata export will run safely combined; the shapefile/sensor-log
// exports in the loop still queue one task per year regardless.
var batchStartYear = 2017;
var batchEndYear = 2024;

var exportResolutionMeters = 30;
var waterbodySizeMeters = 2000;
var islandSizeMeters = 1000;

// Landsat 9 is included by default from 2013 onward (see getYearCollection
// below) - this matches the authoritative sensor log's real l9_count for
// 2021-2024. If you need to exclude it, see the sensor-priority logic
// inside getYearCollection().

// ============================================================
// AREA OF INTEREST (AOI)
// ============================================================

// Using a hand-drawn AOI. In the Code Editor, use the polygon drawing
// tool in the map panel toolbar (top left of the map) to draw your
// study area boundary. GEE will automatically create an Import at the
// top of the script the moment you finish drawing it.
//
// This script's Import is named `AOI` (visible at the top of the
// editor). The line below maps it to `geometry`, since the rest of
// the script references that name throughout. If you rename the
// Import itself to `geometry` later (click the gear icon next to it
// in the Imports panel), you can delete this mapping line.
var geometry = AOI;

Map.centerObject(geometry, 8);
Map.addLayer(geometry, {color: 'red'}, 'AOI boundary');

// ============================================================
// BAND HARMONIZATION
// ============================================================

// Landsat 5 (LT05) and Landsat 7 (LE07) Collection 2 Level 2
// share the same band layout.
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
    // Extended beyond the original 'system:time_start' only, so the
    // scene metadata export at the end of this script has what it needs.
    'system:time_start', 'LANDSAT_PRODUCT_ID', 'CLOUD_COVER',
    'WRS_PATH', 'WRS_ROW', 'GEOMETRIC_RMSE_MODEL',
    'GEOMETRIC_RMSE_MODEL_X', 'GEOMETRIC_RMSE_MODEL_Y'
  ]);
}

// Landsat 8 (LC08) and Landsat 9 (LC09) Collection 2 Level 2
// share the same band layout, different from L5/L7.
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

// ============================================================
// LANDSAT 7 SLC-OFF GAP FILL
// ============================================================

// Applied AFTER compositing, not per scene, so that filling does
// not pull in cloud-contaminated neighbor pixels before the cloud
// mask and median reducer have had a chance to work.
function fillScanLineGaps(image) {
  var filled = image.focal_mean({
    radius: 1,
    kernelType: 'square',
    units: 'pixels',
    iterations: 2
  });
  return image.unmask(filled);
}

// ============================================================
// PER-YEAR COLLECTION BUILDER
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

  var l9 = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2')
    .filterDate(startDate, endDate)
    .filterBounds(geometry)
    .map(harmonizeL89)
    .map(function(img) { return img.set('sensor', 'L9'); });

  // Sensor priority logic:
  // - 2000 to 2002: Landsat 7's Scan Line Corrector was still functional
  //   (failure occurred May 2003), so L7 scenes in this window have no
  //   striping. L5 and L7 are merged here purely to raise scene count,
  //   not to work around any sensor defect.
  // - 2003 to 2011: this is the actual SLC-off overlap window. Landsat 5
  //   was still operating and unaffected by the L7 defect, so it is
  //   prioritized as the primary sensor here. L7 is merged in only to
  //   supplement scene count, and any gaps it contributes are diluted
  //   by the larger share of unaffected L5 pixels in the median.
  // - 2012: the true single-sensor gap year. Landsat 5 had ceased
  //   collection and Landsat 8 had not yet launched (April 2013), so
  //   this year relies entirely on SLC-off Landsat 7 and is the one
  //   year where the post-composite gap fill is doing real work.
  // - 2013 onward: Landsat 8 primary, Landsat 9 added from 2021 onward,
  //   Landsat 7 merged in as a scene count supplement only.
  var merged;
  if (year <= 2011) {
    merged = l5.merge(l7);
  } else if (year === 2012) {
    merged = l7;
  } else {
    merged = l8.merge(l9).merge(l7);
  }
  return merged;
}

function buildAnnualComposite(year) {
  var yearCollection = getYearCollection(year);
  var sceneCount = yearCollection.size();

  // Per-sensor scene counts. This is what lets the manuscript state,
  // with a number rather than an assertion, how much each year's
  // composite actually depended on SLC-off Landsat 7 imagery versus
  // gap-free Landsat 5, 8, or 9 scenes.
  var l5Count = yearCollection.filter(ee.Filter.eq('sensor', 'L5')).size();
  var l7Count = yearCollection.filter(ee.Filter.eq('sensor', 'L7')).size();
  var l8Count = yearCollection.filter(ee.Filter.eq('sensor', 'L8')).size();
  var l9Count = yearCollection.filter(ee.Filter.eq('sensor', 'L9')).size();
  var l7ShareOfScenes = ee.Number(l7Count).divide(
    ee.Number(sceneCount).max(1));

  var composite = yearCollection.median().clip(geometry);

  // Gap fill trigger requires two conditions, not just one:
  //   1. Landsat 7 supplies the majority of that year's scenes.
  //   2. The year is on or after the SLC failure (May 2003), since L7
  //      scenes before that date have no scan line gaps at all, and
  //      flagging those years as gap-filled would misrepresent what
  //      actually happened even though the fill operation itself is
  //      a harmless no-op on ungapped data.
  var l7MajorityShare = 0.5;
  var isPostSlcFailure = year >= 2003;
  // isPostSlcFailure is a plain JS boolean (year is client-side here),
  // while l7ShareOfScenes.gte(...) returns a server-side ee.Number.
  // Mixing the two in a single .and() call throws "Invalid argument
  // specified for ee.Number(): false", since ee.Number can't wrap a
  // raw JS boolean. Branching client-side first avoids the mix.
  var needsGapFill = isPostSlcFailure
    ? l7ShareOfScenes.gte(l7MajorityShare)
    : ee.Number(0);
  composite = ee.Image(ee.Algorithms.If(
    needsGapFill,
    fillScanLineGaps(composite),
    composite
  ));

  return composite.set({
    'year': year,
    'scene_count': sceneCount,
    'l5_count': l5Count,
    'l7_count': l7Count,
    'l8_count': l8Count,
    'l9_count': l9Count,
    'l7_share_of_scenes': l7ShareOfScenes,
    'gap_filled': needsGapFill
  });
}

// ============================================================
// WATER DETECTION (AWEI + OTSU THRESHOLDING)
// ============================================================

function detectWater(image) {
  var awei = image.expression(
    '4 * (GREEN - SWIR1) - (0.25 * NIR + 2.75 * SWIR2)', {
      'GREEN': image.select('green'),
      'NIR': image.select('nir'),
      'SWIR1': image.select('swir1'),
      'SWIR2': image.select('swir2'),
  }).rename('awei');

  var thresholding = require('users/gena/packages:thresholding');
  var scale = 100;
  var bounds = geometry;
  var cannyThreshold = 0.7;
  var cannySigma = 1;
  var minValue = -0.2;
  var th = thresholding.computeThresholdUsingOtsu(
    awei, scale, bounds,
    cannyThreshold, cannySigma, minValue);

  var water = awei.gt(th).rename('water');
  return {water: water, threshold: th};
}

// ============================================================
// REMOVE INLAND WATER AND SMALL ISLANDS
// ============================================================

function removeInlandWaterAndIslands(waterImage) {
  waterImage = waterImage.int();

  var connectedPixelsLand = ee.Number(waterbodySizeMeters)
    .divide(exportResolutionMeters).int();
  var connectedPixelsWater = ee.Number(islandSizeMeters)
    .divide(exportResolutionMeters).int();

  var landFilled = waterImage.addBands(waterImage)
    .reduceConnectedComponents(
      ee.Reducer.median(), 'water', connectedPixelsLand)
    .unmask(99).eq(99).and(waterImage.neq(0));

  var waterFilled = landFilled.addBands(landFilled)
    .reduceConnectedComponents(
      ee.Reducer.median(), 'water_1', connectedPixelsWater)
    .unmask(99).eq(99).and(landFilled.neq(1));

  return waterFilled;
}

// ============================================================
// VECTORIZE AND SIMPLIFY COASTLINE
// ============================================================

function simplifyAndExtractCoastline(vectors) {
  var processedVectors = vectors.map(function(f) {
    var geoms = f.geometry().geometries();
    var lines = geoms.map(function(geom) {
      var coords = ee.Geometry(geom)
        .simplify({maxError: exportResolutionMeters})
        .coordinates().get(0);

      var bufferDistance = ee.Number(exportResolutionMeters).multiply(-1);
      var outputGeom = ee.Geometry.LineString(coords)
        .intersection(geometry.buffer(bufferDistance));
      return ee.Feature(outputGeom);
    });
    return ee.FeatureCollection(lines);
  });
  return processedVectors.flatten();
}

// ============================================================
// MAIN LOOP: EXTRACT SHORELINE + SENSOR LOG FOR EACH YEAR,
// ACCUMULATE SCENE METADATA ACROSS ALL YEARS
// ============================================================

var yearList = ee.List.sequence(batchStartYear, batchEndYear);
var sceneMetadataAll = ee.FeatureCollection([]);

print('Running batch: ' + batchStartYear + ' to ' + batchEndYear);

yearList.getInfo().forEach(function(year) {
  // ---- 1. Annual composite, water detection, coastline vector (unchanged) ----
  var composite = buildAnnualComposite(year);

  var detection = detectWater(composite);
  var water = detection.water;
  var threshold = detection.threshold;

  var landWaterBoundary = removeInlandWaterAndIslands(water);

  var vectors = ee.Image(landWaterBoundary).selfMask()
    .reduceToVectors({
      geometry: geometry,
      scale: exportResolutionMeters,
      eightConnected: true,
      maxPixels: 1e10,
      tileScale: 16
    });

  var coastlineVector = simplifyAndExtractCoastline(vectors);

  Export.table.toDrive({
    collection: coastlineVector,
    description: 'Coastline_' + year,
    folder: 'earthengine',
    fileNamePrefix: 'coastline_' + year,
    fileFormat: 'SHP'
  });

  // ---- 2. Per-year sensor/threshold log (one small export per year -
  // this is the fix for the earlier combined-export memory failure) ----
  var yearSummary = ee.Feature(null, {
    year: year,
    scene_count: composite.get('scene_count'),
    l5_count: composite.get('l5_count'),
    l7_count: composite.get('l7_count'),
    l8_count: composite.get('l8_count'),
    l9_count: composite.get('l9_count'),
    l7_share_of_scenes: composite.get('l7_share_of_scenes'),
    gap_filled: composite.get('gap_filled'),
    otsu_threshold: threshold
  });

  Export.table.toDrive({
    collection: ee.FeatureCollection([yearSummary]),
    description: 'Sensor_Log_' + year,
    folder: 'earthengine',
    fileNamePrefix: 'annual_sensor_threshold_log_' + year,
    fileFormat: 'CSV'
  });

  // ---- 3. Scene-level metadata for this year, accumulated into the
  // combined export below (cheap - just re-reads the same collection's
  // per-image properties, no compositing/Otsu involved) ----
  var yearCollectionForMetadata = getYearCollection(year);

  var withMeta = yearCollectionForMetadata.map(function(img) {
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
      geometric_rmse_model_y: img.get('GEOMETRIC_RMSE_MODEL_Y'),
      // Same year-level values as the Sensor_Log record above, broadcast
      // onto every scene row for convenience - otsu_threshold is NOT
      // included here (see note below the export block).
      gap_filled: composite.get('gap_filled'),
      l7_share_of_scenes: composite.get('l7_share_of_scenes')
    });
  });

  // Accumulate via merge() (server-side FeatureCollection concatenation),
  // NOT via a client-side array + Array.concat() with ee.List objects -
  // the latter silently produces a nested List<List<Feature>> and the
  // final export fails with "Invalid type... Expected List<Element>".
  sceneMetadataAll = sceneMetadataAll.merge(withMeta);

  print('Queued Coastline/Sensor_Log exports and added scene metadata for year ' + year);
});

// Export the full 2000-2024 sensor and threshold log as one table.
// (Kept from the original script - useful as a single reference copy,
// though the authoritative per-year values are in the Sensor_Log_<year>
// files above; if this combined print/export ever fails on a large batch,
// rely on concatenating the per-year Sensor_Log_<year> CSVs instead.)
print('Sensor and threshold summary is now exported per-year as Sensor_Log_<year> - '
  + 'concatenate those CSVs after downloading to rebuild the full 2000-2024 table.');

// ---- Combined scene metadata export - ONE task for the whole batch range ----
// Safe to combine (unlike Sensor_Log) because nothing here touches Otsu
// thresholding, compositing, or reduceToVectors - just per-image metadata
// properties and a cheap centroid, accumulated across at most a few
// hundred scenes per year.
Export.table.toDrive({
  collection: sceneMetadataAll,
  description: 'Scene_Metadata_Full_' + batchStartYear + '_' + batchEndYear,
  folder: 'earthengine',
  fileNamePrefix: 'scene_metadata_full_' + batchStartYear + '_' + batchEndYear,
  fileFormat: 'CSV'
});

print('Queued combined Scene_Metadata_Full_' + batchStartYear + '_' + batchEndYear + ' export.');

/*
After running, go to the Tasks tab. For a batch of N years you will see:
  - N x Coastline_<year> tasks (shapefile)
  - N x Sensor_Log_<year> tasks (CSV, includes otsu_threshold/gap_filled)
  - 1 x Scene_Metadata_Full_<batchStartYear>_<batchEndYear> task (CSV)
Click Run on each to actually submit it.
*/
