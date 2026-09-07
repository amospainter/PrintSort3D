import { describe, it, expect } from 'vitest';
import { parseSliceInfoXml } from './sliceInfo';

// Trimmed from a real Bambu Studio export.
const SINGLE_PLATE = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="01.09.00.53"/>
  </header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="printer_model_id" value="C11"/>
    <metadata key="nozzle_diameters" value="0.4"/>
    <metadata key="prediction" value="4192"/>
    <metadata key="weight" value="15.99"/>
    <metadata key="outside" value="false"/>
    <metadata key="support_used" value="false"/>
    <filament id="1" tray_info_idx="GFA00" type="PLA" color="#000000" used_m="5.29" used_g="15.99"/>
  </plate>
</config>`;

const MULTI_PLATE_MULTI_FILAMENT = `<config>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="3600"/>
    <metadata key="weight" value="20"/>
    <metadata key="support_used" value="true"/>
    <filament id="1" type="PLA" color="#FF0000" used_m="6.5" used_g="12"/>
    <filament id="2" type="PLA" color="#00FF00" used_m="4.0" used_g="8"/>
  </plate>
  <plate>
    <metadata key="index" value="2"/>
    <metadata key="prediction" value="1800"/>
    <metadata key="weight" value="10"/>
    <metadata key="support_used" value="false"/>
    <filament id="1" type="PLA" color="#FF0000" used_m="5.5" used_g="10"/>
  </plate>
</config>`;

describe('parseSliceInfoXml', () => {
  it('reads a single plate', () => {
    const info = parseSliceInfoXml(SINGLE_PLATE)!;
    expect(info.printTimeSeconds).toBe(4192);
    expect(info.filamentWeightGrams).toBe(15.99);
    expect(info.filamentLengthMeters).toBe(5.29);
    expect(info.printerModelId).toBe('C11');
    expect(info.nozzleDiameterMm).toBe(0.4);
    expect(info.supportUsed).toBe(false);
    expect(info.plates).toHaveLength(1);
    expect(info.plates[0].filaments[0]).toEqual({
      id: 1,
      type: 'PLA',
      color: '#000000',
      usedGrams: 15.99,
      usedMeters: 5.29,
    });
  });

  it('aggregates across plates and filaments', () => {
    const info = parseSliceInfoXml(MULTI_PLATE_MULTI_FILAMENT)!;
    expect(info.printTimeSeconds).toBe(5400); // 3600 + 1800
    expect(info.filamentWeightGrams).toBe(30); // 20 + 10
    expect(info.filamentLengthMeters).toBe(16); // 6.5 + 4.0 + 5.5
    expect(info.supportUsed).toBe(true); // any plate
    expect(info.plates).toHaveLength(2);
  });

  it('returns null for a config with no plate blocks', () => {
    expect(parseSliceInfoXml('<config></config>')).toBeNull();
    expect(parseSliceInfoXml('not xml at all')).toBeNull();
  });

  it('tolerates missing fields', () => {
    const info = parseSliceInfoXml('<config><plate><metadata key="index" value="1"/></plate></config>')!;
    expect(info.printTimeSeconds).toBeNull();
    expect(info.filamentWeightGrams).toBeNull();
    expect(info.supportUsed).toBeNull();
  });
});
