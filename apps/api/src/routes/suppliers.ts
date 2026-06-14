import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@sjc/db";
import { requireAuth, requirePermission } from "../lib/guards.js";
import { writeAudit } from "../lib/audit.js";
import { toJson } from "../lib/serialize.js";

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  phone: z.string().max(40).optional(),
  address: z.string().max(200).optional(),
  paymentTermsDays: z.coerce.number().int().min(0).max(120).optional(),
  openingBalance: z.coerce.number().optional(),
  notes: z.string().max(500).optional(),
});

const PaymentBody = z.object({
  amount: z.coerce.number().positive(),
  method: z.enum(["CASH", "CARD", "WALLET", "CREDIT", "BANK_TRANSFER"]),
  reference: z.string().max(120).optional(),
  notes: z.string().max(500).optional(),
});

export async function registerSupplierRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/", async () => {
    const list = await prisma.supplier.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
    });
    return toJson({ suppliers: list });
  });

  /** GET /suppliers/:id — supplier with running balance */
  app.get("/:id", async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const supplier = await prisma.supplier.findUnique({ where: { id } });
    if (!supplier) return reply.code(404).send({ error: "Not found" });

    // Running balance = openingBalance + sum(PO totals) - sum(payments)
    const [poSum, paymentSum] = await Promise.all([
      prisma.purchaseOrder.aggregate({
        _sum: { total: true },
        where: { supplierId: id, status: { not: "CANCELLED" } },
      }),
      prisma.supplierPayment.aggregate({
        _sum: { amount: true },
        where: { supplierId: id },
      }),
    ]);
    const poTotal = poSum._sum.total ?? new Prisma.Decimal(0);
    const paidTotal = paymentSum._sum.amount ?? new Prisma.Decimal(0);
    const balance = supplier.openingBalance.plus(poTotal).minus(paidTotal);

    return toJson({
      supplier,
      balance: balance.toString(),
      summary: {
        opening: supplier.openingBalance.toString(),
        purchased: poTotal.toString(),
        paid: paidTotal.toString(),
      },
    });
  });

  app.post("/", { preHandler: requirePermission("FIN_SUPPLIER_PAY", "ADMIN_USER_MGMT") }, async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body" });
    const created = await prisma.supplier.create({
      data: {
        name: parsed.data.name,
        phone: parsed.data.phone,
        address: parsed.data.address,
        paymentTermsDays: parsed.data.paymentTermsDays ?? 15,
        openingBalance: new Prisma.Decimal(parsed.data.openingBalance ?? 0),
        notes: parsed.data.notes,
      },
    });
    return toJson({ supplier: created });
  });

  /** GET /suppliers/:id/ledger — chronological view of POs and payments */
  app.get("/:id/ledger", async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const supplier = await prisma.supplier.findUnique({ where: { id } });
    if (!supplier) return reply.code(404).send({ error: "Not found" });

    const [pos, payments] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where: { supplierId: id },
        orderBy: { createdAt: "asc" },
        select: { id: true, poNo: true, status: true, total: true, createdAt: true },
      }),
      prisma.supplierPayment.findMany({
        where: { supplierId: id },
        orderBy: { paidAt: "asc" },
        select: { id: true, amount: true, method: true, reference: true, paidAt: true },
      }),
    ]);

    const events: any[] = [
      { type: "OPENING", at: supplier.createdAt, debit: supplier.openingBalance.toString(), credit: "0", note: "Opening balance" },
      ...pos.map((p) => ({
        type: "PURCHASE", at: p.createdAt, debit: p.total.toString(), credit: "0", note: `PO ${p.poNo} (${p.status})`,
      })),
      ...payments.map((p) => ({
        type: "PAYMENT", at: p.paidAt, debit: "0", credit: p.amount.toString(), note: `${p.method}${p.reference ? ` ref:${p.reference}` : ""}`,
      })),
    ].sort((a, b) => +new Date(a.at) - +new Date(b.at));

    // Walk balance through events
    let running = new Prisma.Decimal(0);
    for (const e of events) {
      running = running.plus(e.debit).minus(e.credit);
      e.balance = running.toString();
    }

    return toJson({ supplier, events, balance: running.toString() });
  });

  /** POST /suppliers/:id/pay — record a payment */
  app.post("/:id/pay", { preHandler: requirePermission("FIN_SUPPLIER_PAY") }, async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const parsed = PaymentBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body" });

    const payment = await prisma.supplierPayment.create({
      data: {
        supplierId: id,
        paidById: BigInt(req.auth!.sub),
        amount: new Prisma.Decimal(parsed.data.amount),
        method: parsed.data.method,
        reference: parsed.data.reference,
        notes: parsed.data.notes,
      },
    });
    await writeAudit({ req, action: "supplier.pay", entityType: "Supplier", entityId: id, after: { amount: parsed.data.amount, method: parsed.data.method } });
    return toJson({ payment });
  });
}
