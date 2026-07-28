import { PrismaClient } from "@prisma/client";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";

const adapter = new PrismaMariaDb(process.env.DATABASE_URL!);

const prisma = new PrismaClient({
    adapter,
});

export async function connectDatabase() {
    await prisma.$connect();
    console.log("✅ Database Connected");
}

export async function disconnectDatabase() {
    await prisma.$disconnect();
    console.log("❌ Database Disconnected");
}

export default prisma;