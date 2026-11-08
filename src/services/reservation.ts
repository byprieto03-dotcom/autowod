import { appendFileSync } from 'fs';
import { Page, ElementHandle } from 'puppeteer';
import {
  ButtonText,
  ReservationPreferences,
  ReservationResult,
  WeekDay,
} from '../types';
import { availableDays } from '../config';

export function parsePreferenceValue(value: string | null): {
  time: string | null;
  className: string | null;
} {
  if (!value) return { time: null, className: null };
  const [time, className] = value.split('|');
  return { time: time.trim() || null, className: className?.trim() || null };
}

export async function goToReservations(page: Page): Promise<void> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayInSeconds = Math.floor(today.getTime() / 1000);
  const currentUrl = page.url();
  const currentDomain = new URL(currentUrl).origin;
  await page.goto(`${currentDomain}/athlete/reservas.aspx?t=${todayInSeconds}`);
  await page.waitForNetworkIdle({ timeout: 8000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));
}

export async function getReservationState(
  reservationButton: ElementHandle<Element>
): Promise<ButtonText | null> {
  const buttonText = await reservationButton.evaluate(el => (el.textContent || '').trim());
  return buttonText as ButtonText | null;
}

export function getReservationKey(time: string): string {
  return `h${time.replace(':', '')}00`;
}

export async function goToNextDay(page: Page): Promise<void> {
  // FIX: no pulsar "siguiente" porque salta de semana en semana (lunes a lunes)
  // Ir directo a la URL del dia siguiente sumando 1 dia = 86400 segundos
  const url = page.url();
  const currentSeconds = Number(url.split('=')[1]);
  const nextSeconds = currentSeconds + 86400;
  const currentDomain = new URL(url).origin;
  await page.goto(`${currentDomain}/athlete/reservas.aspx?t=${nextSeconds}`);
  await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));
}

export async function getWeekDayFromUrl(page: Page): Promise<string> {
  const url = await page.url();
  const weekDayInSeconds = url.split('=')[1];
  const weekDay = new Date(Number(weekDayInSeconds) * 1000);
  return weekDay
    .toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
    .toLocaleLowerCase();
}

export async function getDateFromUrl(page: Page): Promise<string> {
  const url = await page.url();
  const weekDayInSeconds = url.split('=')[1];
  return Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(Number(weekDayInSeconds) * 1000));
}

export function getISODateFromUrl(page: Page): string {
  const seconds = page.url().split('=')[1];
  return new Date(Number(seconds) * 1000).toISOString().split('T')[0];
}

async function findReservationButton(
  page: Page,
  reservationKey: string,
  className: string | null,
  time: string | null
): Promise<ElementHandle<Element> | null> {
  const oldButtons = await page.$$(`div[data-magellan-destination="${reservationKey}"] button`);
  if (oldButtons.length > 0) return oldButtons[0];

  if (!time) return null;

  const filterClicked = await page.evaluate((wantedTime: string) => {
    const pills = Array.from(document.querySelectorAll('button, a, div, span'));
    for (const p of pills) {
      if ((p.textContent || '').trim() === wantedTime) {
        const r = (p as HTMLElement).getBoundingClientRect();
        if (r.height < 50 && r.width < 120) {
          (p as HTMLElement).click();
          return true;
        }
      }
    }
    return false;
  }, time);
  if (filterClicked) {
    await new Promise(r => setTimeout(r, 2000));
    await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
  }

  const handle = await page.evaluateHandle((args: { time: string; className: string | null }) => {
    const candidates = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
    for (const btn of candidates) {
      const btnText = (btn.textContent || '').trim().toLowerCase();
      if (!/^(reservar|entrenar|avisar|apuntarse|reservado|cancelar|borrar|cambiar|lista de espera)/.test(btnText) && !btnText.startsWith('no avisar')) continue;
      let card: Element | null = btn as Element;
      for (let i = 0; i < 5 && card; i++) {
        card = card.parentElement;
        if (!card) break;
        const cardText = card.textContent || '';
        const hours = cardText.match(/\d{2}:\d{2}/g) || [];
        const uniqueHours = [...new Set(hours)];
        if (uniqueHours.length !== 1) continue;
        if (uniqueHours[0] !== args.time) continue;
        if (args.className && !cardText.toLowerCase().includes(args.className.toLowerCase())) continue;
        return btn;
      }
    }
    return null;
  }, { time, className });

  const element = handle.asElement();
  return element as ElementHandle<Element> | null;
}

export async function makeReservation(
  page: Page,
  preference: string | null
): Promise<ReservationResult> {
  const { time, className } = parsePreferenceValue(preference);
  const weekDay = await getWeekDayFromUrl(page);
  const date = getISODateFromUrl(page);
  const pageTitle = await page.$('.mainTitle');
  const pageTitleText = (await pageTitle?.evaluate(el => el.textContent)) ?? '';

  if (!time) {
    return {
      success: false,
      message: `📅 No time scheduled for ${weekDay}s`,
      weekDay,
      date,
    };
  }

  const reservationKey = getReservationKey(time);
  const reservationButton = await findReservationButton(page, reservationKey, className, time);

  if (!reservationButton) {
    return {
      success: false,
      message: `🔍 No reservation slot found for ${await getDateFromUrl(page)} at ${time}`,
      weekDay,
      time,
    };
  }

  const cardInfo = await reservationButton.evaluate(el => {
    let node: Element | null = el as Element;
    for (let i = 0; i < 6 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const t = node.textContent || '';
      const hours = t.match(/\d{2}:\d{2}/g) || [];
      if ([...new Set(hours)].length === 1) return t.slice(0, 300);
    }
    return '';
  });
  console.log(`🔒 SAFETY CHECK ${date} - queria ${time} | tarjeta encontrada: ${cardInfo.replace(/\n/g, ' | ')}`);
  if (!cardInfo.includes(time)) {
    return {
      success: false,
      message: `🛑 SAFETY STOP: queria ${time} pero el boton era de otra hora, no he pulsado nada para ${await getDateFromUrl(page)}`,
      weekDay,
      time,
    };
  }

  const rawState = await getReservationState(reservationButton);
  const stateNorm = (rawState || '').trim().toLowerCase();

  let state: ButtonText = (rawState || '') as ButtonText;
  if (stateNorm.includes('reservar')) state = 'Entrenar' as ButtonText;
  else if (stateNorm.includes('entrenar')) state = 'Entrenar' as ButtonText;
  else if (stateNorm.includes('no avisar')) state = 'Borrar' as ButtonText;
  else if (stateNorm.includes('avisar') || stateNorm.includes('lista de espera') || stateNorm.includes('apuntarse')) state = 'Avisar' as ButtonText;
  else if (stateNorm.includes('reservado') || stateNorm.includes('cancelar') || stateNorm.includes('borrar')) state = 'Borrar' as ButtonText;
  else if (stateNorm.includes('finalizada') || stateNorm.includes('finalizado')) state = 'Finalizada' as ButtonText;
  else if (stateNorm.includes('cambiar')) state = 'Cambiar' as ButtonText;

  const result: ReservationResult = {
    success: true,
    message: '',
    weekDay,
    date,
    time,
    state,
  };

  switch (state) {
    case 'Entrenar':
      await reservationButton.click();
      await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
      result.message = `✅ ${pageTitleText} - Successfully booked! 💪`;
      break;
    case 'Avisar':
      await reservationButton.click();
      await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
      result.message = `⏳ ${pageTitleText} - Added to waiting list. Fingers crossed! 🤞`;
      break;
    case 'Cambiar':
      result.message = `⚠️ ${pageTitleText} - You're already booked for a different time slot`;
      result.success = false;
      break;
    case 'Finalizada':
      result.message = `❌ ${pageTitleText} - This class has already finished`;
      result.success = false;
      break;
    case 'Borrar':
      result.message = `ℹ️ ${pageTitleText} - You're already booked`;
      result.success = false;
      break;
    default:
      result.message = `⚠️ Boton con texto desconocido: "${rawState}"`;
      result.success = false;
      break;
  }

  return result;
}

function writeJobSummary(
  dayResults: Array<{ weekDay: string; result: ReservationResult }>,
  counts: {
    booked: number;
    waitlisted: number;
    alreadyBooked: number;
    skipped: number;
    other: number;
  }
) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  const statusLabel = (result: ReservationResult): string => {
    if (!result.time) return '⏭️ Skipped';
    if (result.state === 'Entrenar' && result.success) return '✅ Booked';
    if (result.state === 'Avisar' && result.success) return '⏳ Waitlisted';
    if (result.state === 'Borrar') return 'ℹ️ Already booked';
    if (result.state === 'Finalizada') return '❌ Class already finished';
    if (result.state === 'Cambiar') return '⚠️ Booked at a different time';
    return '🔍 Slot not found';
  };
  const rows = dayResults.map(({ weekDay, result }) => {
    const day = weekDay.charAt(0).toUpperCase() + weekDay.slice(1);
    const time = result.time ?? '—';
    return `| ${day} | ${time} | ${statusLabel(result)} |`;
  });
  const totals = [
    counts.booked > 0 ? `**${counts.booked} booked**` : null,
    counts.waitlisted > 0 ? `${counts.waitlisted} waitlisted` : null,
    counts.alreadyBooked > 0 ? `${counts.alreadyBooked} already booked` : null,
    counts.skipped > 0 ? `${counts.skipped} skipped` : null,
    counts.other > 0 ? `${counts.other} other` : null,
  ].filter(Boolean).join(' · ');
  const lines = [
    '## 🏋️ AutoWOD Booking Results',
    '',
    '| Day | Time | Status |',
    '|-----|------|--------|',
    ...rows,
    '',
    totals,
    '',
  ];
  appendFileSync(summaryFile, lines.join('\n'));
}

export async function processReservations(
  page: Page,
  preferences: ReservationPreferences
): Promise<Array<{ weekDay: string; result: ReservationResult }>> {
  const dayResults: Array<{ weekDay: string; result: ReservationResult }> = [];
  let booked = 0;
  let waitlisted = 0;
  let alreadyBooked = 0;
  let other = 0;
  let skipped = 0;

  for (let i = 0; i < availableDays; i++) {
    const weekDay = await getWeekDayFromUrl(page);
    const preference = preferences[weekDay as WeekDay];
    const result = await makeReservation(page, preference);
    dayResults.push({ weekDay, result });
    console.log(result.message);
    if (!preference) {
      skipped++;
    } else if (result.state === 'Entrenar' && result.success) {
      booked++;
    } else if (result.state === 'Avisar' && result.success) {
      waitlisted++;
    } else if (result.state === 'Borrar') {
      alreadyBooked++;
    } else {
      other++;
    }
    if (i === availableDays - 1) break;
    const dateBefore = getISODateFromUrl(page);
    await goToNextDay(page);
    if (getISODateFromUrl(page) === dateBefore) {
      console.log(`📆 ${dateBefore} is the last bookable day for now — stopping.`);
      break;
    }
  }
  console.log(`📊 Summary -> booked: ${booked}, waitlist: ${waitlisted}, already booked: ${alreadyBooked}, skipped (no time): ${skipped}, other: ${other}`);
  writeJobSummary(dayResults, { booked, waitlisted, alreadyBooked, skipped, other });
  return dayResults;
}
