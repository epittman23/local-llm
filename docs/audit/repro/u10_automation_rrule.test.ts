import { expect, test } from 'vitest';
import { parseRrule, buildRrule, formatSchedule } from '../../../apps/web/src/routes/automations/automationModel';
test('lossy', () => {
  for (const r of ['RRULE:FREQ=MONTHLY;BYDAY=1MO;BYHOUR=9;BYMINUTE=0','RRULE:FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0','RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0;UNTIL=20261231T000000Z'])
    console.log(r, '=>', buildRrule(parseRrule(r)), '|', formatSchedule(r));
});
