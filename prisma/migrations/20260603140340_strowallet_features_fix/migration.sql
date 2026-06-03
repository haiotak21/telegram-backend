-- CreateTable
CREATE TABLE "public"."VirtualBankAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountName" TEXT,
    "bankName" TEXT,
    "sessionId" TEXT,
    "status" TEXT DEFAULT 'active',
    "currency" TEXT DEFAULT 'NGN',
    "responseData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VirtualBankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."UsdtAddress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT,
    "network" TEXT DEFAULT 'TRC20',
    "status" TEXT DEFAULT 'active',
    "responseData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsdtAddress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VirtualBankAccount_accountNumber_key" ON "public"."VirtualBankAccount"("accountNumber");

-- CreateIndex
CREATE INDEX "VirtualBankAccount_userId_idx" ON "public"."VirtualBankAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UsdtAddress_address_key" ON "public"."UsdtAddress"("address");

-- CreateIndex
CREATE INDEX "UsdtAddress_userId_idx" ON "public"."UsdtAddress"("userId");

-- AddForeignKey
ALTER TABLE "public"."VirtualBankAccount" ADD CONSTRAINT "VirtualBankAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UsdtAddress" ADD CONSTRAINT "UsdtAddress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

