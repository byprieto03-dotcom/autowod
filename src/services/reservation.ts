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
  await new Promise(r => setTimeout(r, 2000));
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
  await page.waitForSelector('a.next');
  await page.click('a.next');
  await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 1500));
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

  const buttons = await page.$$('button, a.btn, input[type="button"], input[type="submit"]');
  for (const button of buttons) {
    const info = await button.evaluate(el => {
      const container = el.closest('div')?.parentElement?.textContent || el.parentElement?.textContent || '';
      const ownText = (el.textContent || '').trim().toLowerCase();
      const cardText = (el.closest('div')?.parentElement?.textContent || '').toLowerCase();
      return { ownText, cardText, container: container.toLowerCase() };
    });
    if (!/reservar|entrenar|avisar|apuntarse|lista de espera|reservado|cancelar|borrar|cambiar/.test(info.ownText)) continue;
    if (time && !info.cardText.includes(time) && !info.container.includes(time)) continue;
    if (className && !info.cardText.includes(className.toLowerCase()) && !info.container.includes(className.toLowerCase())) continue;
    return button;
  }
  return null;
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

  const rawState = await getReservationState(reservationButton);
  const stateNorm = (rawState || '').trim().toLowerCase();

  let state: ButtonText = (rawState || '') as ButtonText;
  if (stateNorm.includes('reservar')) state = 'Entrenar' as ButtonText;
  else if (stateNorm.includes('entrenar')) state = 'Entrenar' as ButtonText;
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
