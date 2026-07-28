import { auth } from "@/auth"
import { getUserById } from "@/lib/db/queries/users"
import { ComparePage } from "@/components/analytics/ComparePage"

export default async function Compare() {
  const session = await auth()
  let firstName: string | undefined
  if (session?.user?.id) {
    const user = await getUserById(session.user.id)
    firstName = user?.first_name ?? undefined
  }
  return (
    <div className="flex h-full w-full overflow-hidden">
      <ComparePage firstName={firstName} />
    </div>
  )
}
