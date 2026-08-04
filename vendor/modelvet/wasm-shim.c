/*
 * WASM shim for the modelvet amalgamation.
 *
 * The library is freestanding C11 with no libc and no malloc, so the JS
 * host manages linear memory directly. The only extra symbol the host
 * needs is the start of the free heap: the linker-provided __heap_base
 * (right after static data and stack). JS places the report struct,
 * arena struct, arena storage, and the input file bytes from there.
 */
extern unsigned char __heap_base;

void *mvet_heap_base(void) {
    return &__heap_base;
}

/*
 * compiler-rt builtin: 128-bit multiplication (mod 2^128). modelvet's
 * checked arithmetic lowers some u128 products to __multi3, and we link
 * with -nostdlib, so provide it here. All inner multiplies use 32-bit
 * limbs so clang cannot lower them back to a __multi3 libcall (which
 * would recurse until the wasm stack is exhausted).
 */
typedef unsigned int mvet_u32;
typedef unsigned long long mvet_u64;
typedef unsigned __int128 mvet_u128;

/* 64 x 64 -> 128 schoolbook multiply in 32-bit limbs. */
static mvet_u128 mvet_wide_mul64(mvet_u64 x, mvet_u64 y) {
    mvet_u32 x0 = (mvet_u32)x, x1 = (mvet_u32)(x >> 32);
    mvet_u32 y0 = (mvet_u32)y, y1 = (mvet_u32)(y >> 32);
    mvet_u64 p0 = (mvet_u64)x0 * y0;
    mvet_u64 p1 = (mvet_u64)x0 * y1;
    mvet_u64 p2 = (mvet_u64)x1 * y0;
    mvet_u64 p3 = (mvet_u64)x1 * y1;
    mvet_u64 mid = p1 + p2;
    mvet_u64 c1 = (mid < p1);
    mvet_u64 lo = p0 + (mid << 32);
    mvet_u64 c2 = (lo < p0);
    mvet_u64 hi = p3 + (mid >> 32) + (c1 << 32) + c2;
    return ((mvet_u128)hi << 64) | lo;
}

mvet_u128 __multi3(mvet_u128 a, mvet_u128 b) {
    mvet_u64 a_lo = (mvet_u64)a;
    mvet_u64 a_hi = (mvet_u64)(a >> 64);
    mvet_u64 b_lo = (mvet_u64)b;
    mvet_u64 b_hi = (mvet_u64)(b >> 64);
    /* The (a_hi * b_hi) term is 0 mod 2^128 and is omitted. */
    mvet_u128 r = mvet_wide_mul64(a_lo, b_lo);
    mvet_u64 hi = a_hi * b_lo + a_lo * b_hi;
    return r + ((mvet_u128)hi << 64);
}
