export interface ShowcaseCase {
  id: string
  title: string
  description: string | null
  beforeImageUrl: string
  afterImageUrl: string
  beforeLabel: string
  afterLabel: string
  /** 投放位置，如 login；空数组表示全部位置 */
  placements: string[]
}

export const SHOWCASE_CASES: ShowcaseCase[] = [
  {
    id: "cmrd9p54c003hxf2lja7tspqa",
    title: "项目架构图",
    description: null,
    beforeImageUrl: "/assets/showcase/1dda4adc-bff4-4543-81b5-c4c738a87be2.jpg",
    afterImageUrl: "/assets/showcase/3d873a59-1038-4786-aaaf-bcbc6cf8323c.jpg",
    beforeLabel: "原始",
    afterLabel: "生成",
    placements: [],
  },
  {
    id: "cmrvtj9f800iz4i1i83973orp",
    title: "工作汇报",
    description: null,
    beforeImageUrl: "/assets/showcase/e342d673-b58a-483b-8c9f-60def3423655.png",
    afterImageUrl: "/assets/showcase/da662878-29a5-4ad4-8ea7-0fad69409e5b.png",
    beforeLabel: "原始",
    afterLabel: "生成",
    placements: [],
  },
  {
    id: "cmrvti4bg00i34i1ir5gl2ojb",
    title: "产品介绍",
    description: null,
    beforeImageUrl: "/assets/showcase/88206e54-ee52-4c9c-87ef-e18045a335b0.png",
    afterImageUrl: "/assets/showcase/8d946e0b-8524-44bc-acb3-5845452b62ba.png",
    beforeLabel: "原始",
    afterLabel: "生成",
    placements: [],
  },
  {
    id: "cmrvtisml00im4i1itb2guat8",
    title: "活动流程",
    description: null,
    beforeImageUrl: "/assets/showcase/c3cb9cf9-92d3-47e4-aee4-ec8bf44dd993.png",
    afterImageUrl: "/assets/showcase/f68248fa-10b3-4b11-8ae8-5f16a3fdf9bc.png",
    beforeLabel: "原始",
    afterLabel: "生成",
    placements: [],
  },
]
