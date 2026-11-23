import { prisma } from "../db/client";
import type { HolidayRuleKind } from "@prisma/client";

export function listCountries() {
  return prisma.country.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { holidayRules: true } } },
  });
}

export function findCountry(id: string) {
  return prisma.country.findUnique({ where: { id: id.toUpperCase() } });
}

export function createCountry(params: { id: string; name: string; currency: string; timezones?: string[] }) {
  return prisma.country.create({
    data: {
      id: params.id.toUpperCase(),
      name: params.name,
      currency: params.currency.toUpperCase(),
      timezones: params.timezones ?? [],
    },
  });
}

export async function updateCountry(
  id: string,
  data: { name?: string; currency?: string; active?: boolean; timezones?: string[] }
): Promise<boolean> {
  const { count } = await prisma.country.updateMany({
    where: { id: id.toUpperCase() },
    data: { ...data, currency: data.currency?.toUpperCase() },
  });
  return count > 0;
}

/** "Soportado" = existe Y está activo — un país desactivado no se ofrece como opción nueva. */
export async function isSupportedCountry(id: string): Promise<boolean> {
  const country = await prisma.country.findUnique({ where: { id: id.toUpperCase() } });
  return Boolean(country?.active);
}

export async function supportedCountries(): Promise<
  Array<{ id: string; name: string; currency: string; timezones: string[] }>
> {
  return prisma.country.findMany({
    where: { active: true },
    select: { id: true, name: true, currency: true, timezones: true },
    orderBy: { name: "asc" },
  });
}

export function listHolidayRules(countryId: string) {
  return prisma.holidayRule.findMany({
    where: { countryId: countryId.toUpperCase() },
    orderBy: { createdAt: "asc" },
  });
}

export interface HolidayRuleInput {
  name: string;
  kind: HolidayRuleKind;
  month?: number | null;
  day?: number | null;
  weekday?: number | null;
  ordinal?: number | null;
  offsetDays?: number | null;
}

export function createHolidayRule(countryId: string, input: HolidayRuleInput) {
  return prisma.holidayRule.create({ data: { countryId: countryId.toUpperCase(), ...input } });
}

export async function updateHolidayRule(
  id: string,
  countryId: string,
  input: HolidayRuleInput
): Promise<boolean> {
  const { count } = await prisma.holidayRule.updateMany({
    where: { id, countryId: countryId.toUpperCase() },
    data: input,
  });
  return count > 0;
}

export async function deleteHolidayRule(id: string, countryId: string): Promise<boolean> {
  const { count } = await prisma.holidayRule.deleteMany({
    where: { id, countryId: countryId.toUpperCase() },
  });
  return count > 0;
}
