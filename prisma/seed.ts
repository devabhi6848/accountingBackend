import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const company = await prisma.company.upsert({
    where: { id: '11111111-1111-1111-1111-111111111111' },
    update: {},
    create: {
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Demo Company',
      stateCode: '08',
    },
  });

  await prisma.user.upsert({
    where: { email: 'demo@example.com' },
    update: { companyId: company.id },
    create: {
      id: '22222222-2222-2222-2222-222222222222',
      companyId: company.id,
      name: 'Demo User',
      email: 'demo@example.com',
      passwordHash: 'DEVELOPMENT_ONLY',
      role: 'ADMIN',
    },
  });

  await prisma.account.createMany({
    data: [
      { companyId: company.id, name: 'Sales', type: 'INCOME' },
      { companyId: company.id, name: 'Purchase', type: 'EXPENSE' },
      { companyId: company.id, name: 'Input CGST', type: 'TAX' },
      { companyId: company.id, name: 'Input SGST', type: 'TAX' },
      { companyId: company.id, name: 'Input IGST', type: 'TAX' },
      { companyId: company.id, name: 'Output CGST', type: 'TAX' },
      { companyId: company.id, name: 'Output SGST', type: 'TAX' },
      { companyId: company.id, name: 'Output IGST', type: 'TAX' },
    ],
    skipDuplicates: true,
  });
}

main().finally(() => prisma.$disconnect());
