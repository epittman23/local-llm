# Proposed Inference Server

> **PROPOSED HARDWARE ONLY. NOTHING IN THIS DOCUMENT HAS BEEN PURCHASED.**

| Field          | Value                                   |
| -------------- | --------------------------------------- |
| Document type  | Hardware proposal                       |
| Schema version | 1.0                                     |
| Generated      | 2026-08-22                              |
| Project        | local-llm                               |
| Repository     | https://github.com/epittman23/local-llm |

## Status

| Field                  | Value                    |
| ---------------------- | ------------------------ |
| Purchased              | No                       |
| State                  | `PROPOSED_NOT_PURCHASED` |
| Price observation date | 2026-08-22               |
| Prices valid           | No                       |

**Notice:** NOT PURCHASED. This is a research artifact, not a bill of materials for owned
equipment. No item listed here has been ordered, paid for, or received. All prices, sellers,
and availability are point-in-time observations from eBay on 2026-08-22 and will drift.
Several open questions (see [Open questions](#open-questions)) remain unresolved and could
change the component list. Do not treat any figure here as a confirmed spec of running
hardware.

**On pricing:** used enterprise and GPU pricing moved materially during this research window.
Re-verify every line before ordering.

## Purpose

| Field              | Value                                                                             |
| ------------------ | --------------------------------------------------------------------------------- |
| Role               | Dedicated headless inference server, network-exposed to VS Code and other clients |
| Primary workload   | Agentic coding and reasoning                                                      |
| Secondary workload | Math, statistics, data analysis                                                   |

### Target models

#### Qwen3.8-27B

| Field          | Value                             |
| -------------- | --------------------------------- |
| Architecture   | Dense                             |
| Parameters     | 27.78B                            |
| Quantization   | Q4 (Unsloth UD variant preferred) |
| Size           | 16.7 GB                           |
| Context target | 65536                             |
| VRAM at target | 22 GB                             |

Notes: multimodal; requires a separate ~0.93 GB vision projector for GGUF. Hybrid attention
(Gated DeltaNet on 48 of 64 layers) keeps KV growth sublinear.

#### Qwen3.6-35B-A3B

| Field        | Value              |
| ------------ | ------------------ |
| Architecture | MoE                |
| Quantization | Unsloth UD-Q4_K_XL |
| Size         | 21 GB              |

Notes: fits entirely in 32 GB VRAM; `--n-cpu-moe` becomes unnecessary on this hardware.

### Architectural note

Qwen3.8 shipped as a dense 27B, not the anticipated 35B-A3B MoE. This invalidated the
`--n-cpu-moe` CPU-offload strategy and made VRAM capacity the binding constraint rather than
host memory bandwidth.

## Budget

| Field          | Value     |
| -------------- | --------- |
| Ceiling        | $2,000.00 |
| Proposed total | $1,316.10 |
| Remaining      | $683.90   |

Scope: complete system. Excludes monitor, keyboard, and network switch.

## Components

### Cost summary

| ID                 | Category       | Item                                        |         Total |
| ------------------ | -------------- | ------------------------------------------- | ------------: |
| `gpu`              | GPU            | NVIDIA/HP Tesla V100 PCIe 32GB HBM2         |       $662.00 |
| `chassis`          | Server chassis | Dell PowerEdge R730 (8x 2.5")               |       $292.67 |
| `psu_upgrade`      | Power supply   | Dell 1100W EPP Platinum PSU (x2)            |        $67.96 |
| `riser`            | Riser card     | Dell 800JH R730/R730xd Riser 3 (Alternate)  |        $12.72 |
| `gpu_power_cable`  | Cable          | Dell GPU power cable, riser to GPGPU        |        $14.98 |
| `gpu_power_dongle` | Cable          | NVIDIA CPU 8-pin to dual PCIe 8-pin dongle  |         $7.99 |
| `storage`          | Storage        | Toshiba THNSNJ1T02CSX 1TB 2.5" SATA III SSD |        $93.99 |
| `power_cords`      | Cable          | NEMA 5-15P to IEC C13 power cord (x2)       |        $17.98 |
| `rails`            | Rack hardware  | Dell Sliding ReadyRails II, 2U, B6          |        $70.12 |
| `rack`             | Rack           | 12U 4-post open frame server rack           |        $75.69 |
|                    |                | **Total**                                   | **$1,316.10** |

### GPU: NVIDIA/HP Tesla V100 PCIe 32GB HBM2

| Field            | Value                                                 |
| ---------------- | ----------------------------------------------------- |
| Board ID         | PG500-216                                             |
| NVIDIA part      | 699-2G500-0202-XXX                                    |
| Price            | $662.00                                               |
| Shipping         | $0.00                                                 |
| Total            | $662.00                                               |
| Seller           | Server Part Deals (eBay)                              |
| Condition        | eBay Refurbished / Excellent                          |
| Warranty         | 1 year                                                |
| Returns          | Free returns                                          |
| Seller feedback  | 99.9% (16199)                                         |
| Verified against | NVIDIA Tesla V100 PCIe Product Brief PB-08744-001_v05 |

#### Specifications

| Specification       | Value                                          |
| ------------------- | ---------------------------------------------- |
| VRAM                | 32 GB                                          |
| Memory type         | HBM2                                           |
| Memory bus          | 4096 bits                                      |
| Bandwidth           | 900 GB/s                                       |
| Interface           | PCIe 3.0 x16                                   |
| Form factor         | Dual-slot, full-height, 10.5 in                |
| TDP                 | 250 W                                          |
| Cooling             | Passive; requires chassis airflow              |
| Compute capability  | 7.0 (Volta, sm_70)                             |
| BAR1                | 32 GB                                          |
| PCI device ID       | `10de:1db6`                                    |
| Aux power connector | 1x CPU 8-pin (EPS-style), NOT PCIe 8-pin       |
| Display outputs     | 0                                              |
| ECC                 | Enabled by default; leave enabled              |
| BF16 support        | No                                             |
| Heatsink airflow    | Bidirectional (left-to-right or right-to-left) |

**Verification note:** PG500 is consistent with the 2G500 PCIe board family, corroborating
that this is a native PCIe card rather than an SXM2 conversion. Confirm on arrival via PCI
device ID.

### Server chassis: Dell PowerEdge R730 (8x 2.5")

| Field           | Value                          |
| --------------- | ------------------------------ |
| Price           | $204.99                        |
| Shipping        | $87.68                         |
| Total           | $292.67                        |
| Seller          | Garland Computer (eBay)        |
| Condition       | Used, off-lease                |
| Returns         | Free returns (30 day)          |
| Seller feedback | 99.9% (102295), Top Rated Plus |

#### Specifications

| Specification | Value                                                 |
| ------------- | ----------------------------------------------------- |
| Form factor   | 2U rack                                               |
| Depth         | 26.92 in                                              |
| Width         | 17.49 in                                              |
| Height        | 3.44 in                                               |
| CPU           | 2x Intel Xeon E5-2660 v3, 10-core, 2.6 GHz, 105 W TDP |
| RAM           | 32 GB DDR4-2133 ECC RDIMM (4x 8 GB, 24 slots total)   |
| RAID          | PERC H730 1 GB                                        |
| NIC           | Quad-port 1GbE BASE-T daughter card                   |
| BMC           | iDRAC 8 Enterprise                                    |
| PSU included  | 2x 750 W Platinum                                     |
| Drive trays   | 8x 2.5 in included                                    |
| PCIe slots    | Up to 7x PCIe 3.0 plus dedicated PERC slot            |

#### GPU qualification

Internal GPU supported: yes.

**Critical note:** the R730 supports internal GPUs; the R730xd does NOT. Verify the model on
arrival.

| Dell requirement    | Value                                       | Status                                                            |
| ------------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| Both CPUs installed | 2 installed                                 | SATISFIED                                                         |
| CPU TDP maximum     | 135 W                                       |                                                                   |
| CPU TDP actual      | 105 W                                       | SATISFIED                                                         |
| PSU requirement     | Redundant 1100 W; set to non-redundant mode | NOT SATISFIED by stock 750 W units; see the PSU upgrade component |

#### Concerns

- Listing uses stock photos, not the actual unit.
- Only 4 of 24 DIMM slots populated; half the memory channels idle. Irrelevant while models
  are fully VRAM-resident.
- Estimated idle draw 150-180 W; roughly $180-220/yr at typical US residential rates running
  24/7.

### Power supply: Dell 1100W EPP Platinum PSU

| Field           | Value                              |
| --------------- | ---------------------------------- |
| Part numbers    | Y26KX, 0Y26KX, CMPGM, PR21C, W12Y2 |
| Model           | Delta D1100E-S0 / DPS-1100BB B     |
| Quantity        | 2                                  |
| Price each      | $33.98                             |
| Total           | $67.96                             |
| Seller          | g-electronic (eBay)                |
| Condition       | Used                               |
| Seller feedback | 99.7%                              |

#### Specifications

| Specification      | Value                                 |
| ------------------ | ------------------------------------- |
| Output at 100-120V | 1050 W                                |
| Output at 200-240V | 1100 W                                |
| Input voltage      | 100-240V 50/60Hz                      |
| Max AC current     | 12 A at low line, 6.5 A at high line  |
| Efficiency         | 80 Plus Platinum                      |
| Inlet type         | IEC C14 (confirmed from seller photo) |
| Hot plug           | Yes                                   |

#### Notes

- The listing title says R740, but Y26KX spans 13G and 14G: R530, R540, R630, R640, R730,
  R730XD, R740, R740XD, R930, T630, T640 and others.
- Both cords on one household circuit provides PSU-failure protection only, not feed
  redundancy. Consider one on UPS and one on wall, or two separate circuits.
- Enable iDRAC Hot Spare to avoid the efficiency penalty of running both at ~30% load.

### Riser card: Dell 800JH PowerEdge R730/R730xd Riser 3 (Alternate)

| Field           | Value               |
| --------------- | ------------------- |
| Part number     | 0800JH              |
| Price           | $12.72              |
| Shipping        | $0.00               |
| Total           | $12.72              |
| Seller          | Enterasource (eBay) |
| Condition       | Used                |
| Returns         | 60 day              |
| Seller feedback | 100% (9195)         |

#### Specifications

| Specification    | Value                                           |
| ---------------- | ----------------------------------------------- |
| Silkscreen       | SLOT6_G3_X16 (CPU1) / RISER3_LEFT (Alternate)   |
| Slots            | 1x PCIe Gen3 x16, full length, full width       |
| CPU mapping      | CPU1                                            |
| GPU power header | Present (white connector, upper right of board) |

#### Notes

- NOT the DT9H6 standard Riser 3, which is a 2x x8 card and cannot host a double-wide x16
  GPU.
- The CPU1 mapping is what makes single-socket GPU operation possible. With both sockets
  populated, standard Riser 2 x16 may suffice instead. UNRESOLVED: see
  [Open questions](#open-questions).

### Cable: Dell GPU power cable, riser to GPGPU

| Field        | Value                         |
| ------------ | ----------------------------- |
| Part numbers | 0N08NH, 09H6FV, 9H6FV         |
| Alternates   | 0J30DG                        |
| Price        | $13.03                        |
| Shipping     | $1.95                         |
| Total        | $14.98                        |
| Seller       | 91fairdeals (eBay)            |
| Condition    | New                           |
| Returns      | Free returns (30 day)         |
| Source end   | 8-pin                         |
| Device end   | 1x PCIe 8-pin + 1x PCIe 6-pin |

#### Notes

- Matches NVIDIA's supported dongle feed configuration: 1x PCIe 8-pin plus 1x PCIe 6-pin,
  with the 6-pin leg rated to 120 W.
- Marked ALMOST GONE at time of research.

### Cable: NVIDIA CPU 8-pin to dual PCIe 8-pin dongle

| Field           | Value                 |
| --------------- | --------------------- |
| Part number     | 030-0571-000          |
| Dell equivalent | 0VM577                |
| Price           | $7.99                 |
| Shipping        | $0.00                 |
| Total           | $7.99                 |
| Seller          | dexe5290 (eBay)       |
| Condition       | New (unbranded clone) |
| Seller feedback | 99.6% (9840)          |

#### Specifications

| Specification | Value                   |
| ------------- | ----------------------- |
| Connector A   | 2x PCIe 8-pin female    |
| Connector B   | 1x CPU 8-pin (12V) male |
| Rated         | 300 W                   |
| Required      | 175 W                   |
| Length        | Under 1 ft              |

#### Notes

- The part number is NVIDIA's own, specified by name in the V100 PCIe product brief.
- The rating is derived from connector specs, not certified. 300 W against a 175 W
  requirement is ample.
- Carries over unchanged to a tower build if the rack route is abandoned.

### Storage: Toshiba THNSNJ1T02CSX 1TB 2.5" SATA III SSD

| Field           | Value                               |
| --------------- | ----------------------------------- |
| Price           | $93.99                              |
| Shipping        | $0.00                               |
| Total           | $93.99                              |
| Seller          | kI0 (eBay)                          |
| Condition       | eBay Refurbished / Excellent        |
| Warranty        | 1 year                              |
| Returns         | 30 day, seller pays return shipping |
| Seller feedback | 99.6% (62010)                       |

#### Specifications

| Specification | Value                    |
| ------------- | ------------------------ |
| Capacity      | 1024 GB                  |
| Interface     | SATA III                 |
| Form factor   | 2.5 in, 7 mm             |
| Type          | OEM enterprise SATA line |

**Compatibility note:** R730 bays are 2.5 in SAS/SATA. SATA drives work on the SAS backplane.
U.2 NVMe drives are physically similar but NOT supported; the R730 does not support Express
Flash.

#### Capacity plan

| Allocation                 | Value  |
| -------------------------- | ------ |
| OS, CUDA, llama.cpp        | 50 GB  |
| Production models          | 38 GB  |
| Remaining for quant sweeps | 900 GB |
| Free bays                  | 7      |

### Cable: NEMA 5-15P to IEC C13 power cord, 14 AWG, 3 ft

| Field     | Value              |
| --------- | ------------------ |
| Quantity  | 2                  |
| Total     | $17.98             |
| Seller    | technichaus (eBay) |
| Condition | New                |
| Returns   | Free returns       |

#### Notes

- C13, not C19. Confirmed against the seller photo of the PSU C14 inlet.
- 14 AWG exceeds requirement; 16 or 18 AWG would suffice at ~6 A continuous draw.
- Both the stock 750 W and replacement 1100 W units use C14.

### Rack hardware: Dell Sliding ReadyRails II, 2U, B6

| Field            | Value                    |
| ---------------- | ------------------------ |
| Part numbers     | 0XV104, XV104            |
| Cross references | 0TKYT, 24V27             |
| Price            | $50.00                   |
| Shipping         | $20.12                   |
| Total            | $70.12                   |
| Seller           | westcoastservices (eBay) |
| Condition        | Used                     |
| Seller feedback  | 100%                     |

#### Specifications

| Specification      | Value                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| Family code        | B6                                                                                                          |
| Type               | Sliding                                                                                                     |
| Compatible servers | R530, R720xd, R730, R740 and other 2U PowerEdge                                                             |
| Mounting           | Tool-less in square-hole or unthreaded round-hole racks; threaded-hole racks require an adapter bracket kit |

### Rack: 12U 4-post open frame server rack, adjustable depth, casters

| Field     | Value                    |
| --------- | ------------------------ |
| Price     | $75.69                   |
| Shipping  | $0.00                    |
| Total     | $75.69                   |
| Seller    | kojem-superparts1 (eBay) |
| Condition | New                      |
| Returns   | Free returns             |

#### Specifications

| Specification           | Value                       |
| ----------------------- | --------------------------- |
| Height                  | 12U                         |
| Posts                   | 4                           |
| Adjustable depth        | 23-40 in                    |
| Required post-to-post   | 26-30 in                    |
| Required interior depth | 32 in minimum, 36 in target |

#### Concerns

- Hole type not stated. ReadyRails II need an adapter kit for threaded posts. UNRESOLVED: see
  [Open questions](#open-questions).
- Verify the weight rating clears ~60 lb for a loaded R730.
- Casters plus a top-mounted server is a tipping hazard. Mount low.

## Not yet sourced

### Dell GPU air baffle / shroud

| Field    | Value                                    |
| -------- | ---------------------------------------- |
| Source   | Component of GPU enablement kit 490-BCDP |
| Priority | Medium                                   |

The R730's six hot-plug fans provide front-to-back airflow chassis-wide. The baffle directs
it specifically across the GPU. A viable fallback is raising static fan speed via iDRAC 8 IPMI
control and monitoring temperature against NVIDIA's limits.

Rejected alternative: third-party blower fan shroud ($38.98). Correct for a tower build;
likely does not fit a 2U riser position and would fight chassis airflow.

### Additional DDR4-2133 ECC RDIMM

| Field    | Value          |
| -------- | -------------- |
| Priority | Low / deferred |

20 free DIMM slots. Higher value than additional storage: 64 GB would let the Linux page cache
hold two or three models simultaneously, eliminating reload penalties during quant sweeps. Not
needed for inference itself, since models are fully VRAM-resident.

## Open questions

### Q1: Which riser cards are installed in the R730 chassis?

| Field    | Value |
| -------- | ----- |
| Blocking | No    |

- **Impact:** determines whether the 800JH alternate Riser 3 is required. With both CPU
  sockets populated, standard Riser 2 x16 may host the GPU directly.
- **Action:** message Garland Computer before ordering the riser.
- **Note:** at $12.72 with returns accepted, buying blind is cheaper than waiting.

### Q2: What hole type does the 12U open frame rack use?

| Field    | Value   |
| -------- | ------- |
| Blocking | **Yes** |

- **Impact:** threaded-hole racks require an adapter bracket kit for sliding ReadyRails II.
- **Action:** check the listing description or message the seller before ordering.

### Q3: Is Dell's 1100 W PSU requirement firmware-enforced or advisory?

| Field    | Value |
| -------- | ----- |
| Blocking | No    |

- **Impact:** determines whether the PSU upgrade is mandatory or optional. Estimated peak load
  is ~650 W, within a single 750 W unit's electrical capability.
- **Action:** test the machine on stock 750 W supplies with the GPU installed before
  committing to the upgrade.

## Software configuration

### Driver

| Field  | Value                    |
| ------ | ------------------------ |
| Branch | R580                     |
| Type   | Long Term Support Branch |
| EOL    | August 2028              |

Constraint: R580 is the LAST NVIDIA driver branch supporting Volta (sm_70). R535 reached EOL
June 2026 and R570 February 2026, so R580 is the only currently-supported branch carrying
Volta.

### CUDA toolkit

| Field   | Value |
| ------- | ----- |
| Version | 12.x  |

Constraint: CUDA Toolkit 13.0 removed sm_70 as a compilation target (the minimum is Turing).
Driver R580 speaks CUDA 13, but the TOOLKIT must be 12.x to emit Volta code. These are
separate concerns.

### llama.cpp

| Field              | Value                                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| Build flags        | `-DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=70`                           |
| Change from laptop | The laptop build uses `ARCHITECTURES=86` (Ampere); the V100 requires 70. |
| Reported arch      | llama.cpp reports Qwen3.8 as arch `qwen35`                               |

Server flags note: drop `--n-cpu-moe` entirely. Qwen3.8-27B is dense (no experts to offload)
and Qwen3.6-35B-A3B fits entirely in 32 GB VRAM. Use `-ngl 99`.

### GPU power management

| Field            | Value                                                                       |
| ---------------- | --------------------------------------------------------------------------- |
| Persistence mode | `nvidia-smi -pm 1`                                                          |
| Power limit      | `nvidia-smi -pl 180`                                                        |
| Documented by    | NVIDIA V100 PCIe product brief, Max-Q mode; any value below 250 W permitted |

Rationale: inference at batch size 1 is bandwidth-bound. Power limiting costs minimal
throughput and substantially eases the passive-cooling problem.

### Storage controller

- **Requirement:** H730 must be set to HBA mode (firmware 25.5.x+) OR the SSD defined as a
  single-disk RAID 0 volume.
- **Recommendation:** HBA mode, so SMART data passes through for drive health monitoring.

### Fan control

| Field             | Value                                                                                |
| ----------------- | ------------------------------------------------------------------------------------ |
| Enable manual     | `ipmitool raw 0x30 0x30 0x01 0x00`                                                   |
| Set speed         | `ipmitool raw 0x30 0x30 0x02 0xff 0xNN`                                              |
| Restore auto      | `ipmitool raw 0x30 0x30 0x01 0x01`                                                   |
| Automation option | `kk7ds/dellfancontrol` (PID-based, written for R730xd third-party hardware fan ramp) |

- **Capability:** iDRAC 8 retains IPMI raw fan commands. Dell PERMANENTLY removed this on
  iDRAC 9 / 14G (R740) from firmware 3.34.34.34 onward.
- **Tuning note:** lower is not always quieter. One R730 owner found 11% optimal for minimum
  perceived noise, as lower speeds produced a more noticeable low-frequency tone.
- **Expected trigger:** the V100 will trigger the third-party PCIe card fan ramp. This
  override is the mitigation.

### Network exposure

| Field              | Value                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Primary option     | Tailscale (zero open ports)                                                                      |
| Alternative        | Cloudflare Tunnel with custom domain                                                             |
| Frontend           | Open WebUI                                                                                       |
| Client integration | VS Code Copilot Chat BYOK custom endpoint; only `base_url` changes from the laptop configuration |

## Thermal limits

Source: NVIDIA Tesla V100 PCIe Product Brief PB-08744-001_v05.

| Limit                   | Value                      |
| ----------------------- | -------------------------- |
| GPU max operating       | 83 C                       |
| GPU slowdown            | 87 C (50% clock reduction) |
| GPU shutdown            | 90 C                       |
| HBM max                 | 85 C                       |
| Ambient operating range | 0 to 45 C                  |

## Acceptance tests

### 1. Verify card identity

| Field         | Value                                                                      |
| ------------- | -------------------------------------------------------------------------- |
| Command       | `lspci -nn \| grep -i nvidia`                                              |
| Pass criteria | Returns `10de:1db6` (32 GB PCIe V100). `10de:1db4` indicates a 16 GB card. |
| Priority      | Critical                                                                   |
| Timing        | Day one, well inside the return window                                     |

### 2. Memory health

| Field         | Value                                               |
| ------------- | --------------------------------------------------- |
| Command       | `nvidia-smi -q`                                     |
| Pass criteria | 32 GB reported, zero retired pages, zero ECC errors |

### 3. Sustained thermal

| Field         | Value                                                         |
| ------------- | ------------------------------------------------------------- |
| Command       | `gpu-burn 1800`                                               |
| Pass criteria | GPU stays below 83 C for 30 minutes. Validates the fan curve. |

### 4. Throughput benchmark

| Field         | Value                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command       | `llama-bench` on Qwen3.8-27B Q4, at 4k and 64k context                                                                                               |
| Pass criteria | Compare against the RTX 3090 reference figures below. Materially lower results indicate Volta kernel paths cost more than bandwidth parity predicts. |
| Priority      | High                                                                                                                                                 |

Note: this is the single largest unverified assumption in the build.

### 5. Tool calling

| Field         | Value                                                     |
| ------------- | --------------------------------------------------------- |
| Command       | Existing tool-calling suite via the VS Code BYOK endpoint |
| Pass criteria | No looping, empty responses, or malformed tool calls      |

Rationale: tool calling degrades first under quantization and is the capability the workflow
actually depends on.

## Reference benchmarks

Source: Hardware Corner, Qwen3.8-27B, Unsloth Q4_K_S (16.68 GiB, 27.32B params), llama.cpp.

**Note:** no published V100 benchmark for this model exists. The 35-40 t/s estimate is
arithmetic from 900 GB/s bandwidth parity with the 3090, NOT a measurement.

| Context | VRAM (GB) | RTX 3090 (t/s) | RTX 4090 (t/s) | RTX 5090 (t/s) | NVIDIA GB10 (t/s) | Apple M5 Max (t/s) |
| ------: | --------: | -------------: | -------------: | -------------: | ----------------: | -----------------: |
|    4096 |        18 |           40.3 |           46.2 |           74.8 |              12.2 |               31.4 |
|   32768 |        20 |           37.0 |           42.2 |           29.0 |               n/a |               21.6 |
|   65536 |        22 |           33.9 |           38.4 |           26.2 |              9.72 |               18.2 |
|  131072 |        26 |            n/a |            n/a |           22.8 |              8.03 |                n/a |

VRAM at 256k context: 34 GB.

**Competing model note:** on the same RTX 3090, Meta Muse Glimmer 30B was faster at every
comparable context length and stayed within 24 GB out to 256k. Benchmark both before
committing Qwen3.8 as the daily driver.

## Risks

### V100 throughput on Qwen3.8-27B is unverified

| Field    | Value |
| -------- | ----- |
| Severity | High  |

- **Detail:** no published benchmark exists. The estimate derives from bandwidth parity with
  the RTX 3090 (900 vs 936 GB/s). llama.cpp's Volta kernels are less optimized than its Ampere
  paths, particularly for prompt processing and flash attention.
- **Mitigation:** acceptance test 4, run inside the return window.

### Volta software end-of-life

| Field    | Value  |
| -------- | ------ |
| Severity | Medium |

- **Detail:** supported until August 2028 on the R580 LTSB, then nothing. No further cuBLAS or
  cuDNN feature work in the interim.
- **Mitigation:** accept as a roughly two-year horizon on a $662 card.

### No BF16 support

| Field    | Value  |
| -------- | ------ |
| Severity | Medium |

- **Detail:** SM70 supports FP16 and FP32 only. Irrelevant for GGUF Q4 under llama.cpp; a hard
  blocker for any future migration to vLLM or SGLang, which assume BF16 weights and FP8 KV
  cache.
- **Mitigation:** none. This is a deliberate constraint accepted at purchase.

### Passive GPU cooling in an untested configuration

| Field    | Value  |
| -------- | ------ |
| Severity | Medium |

- **Detail:** no GPU air baffle sourced. Relies on chassis airflow plus manual fan speed
  elevation.
- **Mitigation:** acceptance test 3; source the Dell baffle if temperatures are marginal.

### Acoustics

| Field    | Value  |
| -------- | ------ |
| Severity | Medium |

- **Detail:** a 2U server with fan speeds raised to feed a passive Tesla is not quiet.
  Placement in an occupied room was ruled out as a design constraint.
- **Mitigation:** iDRAC 8 IPMI fan control; requires the machine to live somewhere out of
  earshot.

### Market volatility

| Field    | Value  |
| -------- | ------ |
| Severity | Medium |

- **Detail:** used RTX 3090 pricing moved from a quoted $600-800 in April 2026 to $1,100-1,500+
  by August 2026. DDR5 32 GB kits moved from ~$95 pre-shortage to $380-589. GPU street prices
  rose 30-40% since June.
- **Mitigation:** re-verify all pricing before purchase. Waiting is not clearly advantageous;
  the trend is upward.

## Alternatives evaluated and rejected

### Used RTX 3090 24GB

Rose to $1,100-1,500 during the research window, consuming 55-75% of budget for 24 GB versus
the V100's 32 GB at $662. Cost per GB: ~$46-63 vs ~$21.

### Intel Arc Pro B60 24GB

Price: $599-800. Requires abandoning the CUDA llama.cpp build for SYCL or Vulkan. 456 GB/s is
roughly half the V100's bandwidth. Remains the fallback if the machine must live in an
occupied room.

### Ryzen AI Max+ 395 (Strix Halo) 64GB mini PC

Price: $1,959-2,000. ~256 GB/s bandwidth yields an estimated 12-18 t/s. Consumes the entire
budget for roughly a third of the V100's projected throughput. Retains appeal purely on
acoustics and power.

### NVIDIA DGX Spark / GB10

Price: $4,699. Measured at only 12.2 t/s on this exact model at 4k context. Worst value in the
comparison for this workload despite the strongest marketing.

### Apple Mac Studio M4 Max 36GB

Price: $2,499. 410-546 GB/s and near-silent operation make it the best non-GPU option, but list
price exceeds budget. Worth revisiting on refurbished or clearance channels if acoustics become
the deciding constraint.

### ASUS ExpertCenter PN55 (Ryzen AI 400, XDNA2 NPU)

Price: $1,299. DDR5-5600 dual-channel SODIMM yields ~90 GB/s, giving an estimated 3-4 t/s on a
dense 27B. The 55 TOPS NPU figure is irrelevant: a 27B at 30 t/s needs ~1.6 TOPS of compute but
~500 GB/s of bandwidth. Slower than the existing laptop setup.

### Dell PowerEdge R740

Dell permanently removed IPMI manual fan control on 14G iDRAC 9 from firmware 3.34.34.34. Once
a unit takes the June 2024 firmware (7.00.00.172), downgrade below 4.40.10.00 is blocked,
making the loss irreversible on a used purchase. Its 6-channel memory advantage (~128 vs ~77
GB/s per socket) is moot because both target models fit entirely in 32 GB VRAM.

### Tower build (ATX, Ryzen 5600G, 3D-printed blower shroud)

Estimated $1,304-1,552. Remains a viable alternative and was briefly the recommendation. The
R730 won on price once the $205 chassis was found, and on parts availability. Revisit if the
rack route stalls; the 030-0571-000 dongle carries over unchanged.

## Key findings

1. Qwen3.8 shipped as a dense 27B, not the anticipated 35B-A3B MoE. This invalidated the
   `--n-cpu-moe` strategy and made VRAM capacity, not host memory bandwidth, the binding
   constraint.
2. With 32 GB of VRAM, both target models become fully GPU-resident, which eliminates the host
   memory bandwidth argument for newer server generations.
3. TOPS is the wrong metric for LLM inference. A 27B at 30 t/s needs ~1.6 TOPS of compute and
   ~500 GB/s of bandwidth. This is why a 55 TOPS NPU cannot do what a 285 TOPS GPU does.
4. iDRAC 8 versus iDRAC 9 fan control is the single most important practical difference between
   the R730 and R740 for a home or office deployment, and it favors the older machine.
5. Driver branch support and CUDA toolkit architecture support are separate concerns. R580
   speaks CUDA 13 but Toolkit 12.x is required to emit sm_70 code.
6. The V100 uses a CPU 8-pin (EPS) power connector, not PCIe. NVIDIA supports either a single
   CPU 8-pin cable or the 030-0571-000 dongle fed by two PCIe cables.
7. Storage speed is irrelevant during inference. Weights are read from VRAM at 900 GB/s; the
   disk is untouched. It matters only for cold model loads and OS responsiveness.