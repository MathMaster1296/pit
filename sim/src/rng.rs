//! PCG32, hand-rolled so the whole sim is dependency-free and runs the same
//! everywhere, including under wasm. Same seed in, same market out.

pub struct Pcg32 {
    state: u64,
    inc: u64,
}

impl Pcg32 {
    pub fn new(seed: u64) -> Pcg32 {
        let mut r = Pcg32 {
            state: 0,
            inc: (0xda3e39cb94b95bdb << 1) | 1,
        };
        r.next_u32();
        r.state = r.state.wrapping_add(seed);
        r.next_u32();
        r
    }

    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old.wrapping_mul(6364136223846793005).wrapping_add(self.inc);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }

    /// Uniform in 0..n. Has modulo bias, which is irrelevant at these sizes.
    pub fn below(&mut self, n: u32) -> u32 {
        self.next_u32() % n
    }

    /// Uniform in [0, 1).
    pub fn unit(&mut self) -> f64 {
        self.next_u32() as f64 / (u32::MAX as f64 + 1.0)
    }

    pub fn chance(&mut self, p: f64) -> bool {
        self.unit() < p
    }

    /// Approximately standard normal via Irwin-Hall (sum of 12 uniforms,
    /// minus 6). The tails are clipped at six sigma, which for driving a toy
    /// price process is fine.
    pub fn gauss(&mut self) -> f64 {
        let mut s = 0.0;
        for _ in 0..12 {
            s += self.unit();
        }
        s - 6.0
    }
}
