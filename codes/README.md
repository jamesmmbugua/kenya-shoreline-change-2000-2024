# codes

Each notebook finds the repository root by itself (the folder that contains `Master_raw`), reads its inputs from `Master_raw/`, and writes everything to `Outputs/`. The first code cell of every notebook lists its inputs and marks each one `ok` or `MISSING`. No other setup file is needed.

## Output folders

| Folder | Contents |
|---|---|
| `Outputs/Figures` | Manuscript figures, named after the figure (PNG and PDF) |
| `Outputs/Tables` | Manuscript tables, named after the table (CSV) |
| `Outputs/Tables/Text_statistics` | Statistics quoted in Sections 4.2.1 to 4.2.6 |
| `Outputs/<stage folder>` | Working files for each notebook (e.g. `Landsat_sensor_summary`, `EOT20_PMSL_tide`, `DSAS_Uncertainty`, `GLORYS_attribution`, `Geostatistics`, `Erosion_Geostats_summary`, `Site_validation`) |

## Run order and inputs

| Notebook | Produces | Inputs in `Master_raw/` |
|---|---|---|
| 01, 01b (GEE Code Editor) | Shorelines, sensor log, scene metadata | online |
| 02 | Tables S1, S2; Figure S2; RMSE_y | `Sensor_log/KE_compiled_sensor_log_2000_2024.xlsx`; `Satellite_Coastlines_GEE/Sensor log/scene_metadata_full_2000_2024.csv` |
| 03 | Table A1; U_eta | `EOT20_tides/*_ocean_eot20.nc`; `Tide_Gauge_PSMSL/PMSL_Hourly_sealevel_data_mombasa.csv`; scene times (see note) |
| 04 | Figure S3; clipped DEM | `Elevation/East Africa_SRTM_30m.tif` (download) |
| 05 | Figure 3; Table A2; DSAS-ready shorelines | `DSAS_inputs/ke_shorelines_2000_2024_UTM37S.shp`, `DSAS_inputs/ke_transects_30mtr.gpkg`; outputs of 02, 03, 04 |
| DSAS (ArcGIS Pro, manual) | `Transect_rates/ke_30mtr_transects_dsas_uncy.gpkg` | DSAS-ready shorelines from 05 |
| 06 | Figure S4; Tables B1, B2; completed transects | `Sea_Surface_height/GLORYS12V1_zos_Kenya_1995_2025_monthly.nc`; `Transect_rates/ke_30mtr_transects_dsas_uncy.gpkg`; `Base_maps/Study_zones_kwale_mom_Tana.shp` |
| 07a | QC tables, 47-cell table, weights | completed transects; DSAS rates; GLORYS midpoint GeoPackage (from 06) |
| 07b | Tables 1, 2; Figures 6, 7a, 7b, 8; Section 4.2 statistics | completed transects |
| 07c | Cell-level sensitivity | outputs of 07a |
| 08 | Figures 9, 10; Tables S3, S4, S5 | `Ground_surveys/coastal_erosion_82sites.shp`; completed transect shapefile |
| 09 | Figures 4, 5 | `DSAS_inputs/` shorelines and transects; completed transects; `Base_maps/` study zones and `gadm41_KEN_1.shp` |

**Completed transects.** Notebooks 07a, 07b, 08 and 09 use the stage 06 outputs in `Outputs/GLORYS_attribution/` when they exist, and otherwise the copies in `Master_raw/Transect_rates/`.

**Scene times (03).** If `Satellite_Coastlines_GEE/Sensor log/compiled_scene_metadata_timestamp_2000_2024.csv` is not present, notebook 03 builds the same columns from `scene_metadata_full_2000_2024.csv` and says so.

Figure 1 (study area map), Figure 2 (schematic) and Figure S1 (GEE map panels) are not produced by code.
